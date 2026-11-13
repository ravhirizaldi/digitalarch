import http from 'node:http';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream';
import { openSafe } from './storage.mjs';
import { failure, publicError } from './errors.mjs';
import { matchRoute } from '../src/routes.js';

async function readBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16 * 1024) throw failure('invalid_request', 'Request body too large.', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch {
    throw failure('invalid_request', 'Expected a JSON object.');
  }
}

export function createHttpApp(service, publicDir = path.resolve('dist')) {
  return http.createServer(async (req, res) => {
    req.correlationId = randomUUID();
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
    };
    res.setHeader('X-Request-ID', req.correlationId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (
      !/^localhost(?::\d+)?$|^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host || '') ||
      req.headers['sec-fetch-site'] === 'cross-site'
    )
      return json(403, { error: 'Local access only.' });
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (!['GET', 'HEAD', 'POST', 'PATCH'].includes(req.method))
        return json(405, { error: 'Method not allowed.' });
      const mutation = ['POST', 'PATCH'].includes(req.method);
      if (mutation && (req.headers.origin !== url.origin || req.headers['x-scan-request'] !== '1'))
        return json(403, { error: 'Requests must come from this page.' });
      let handle;
      let mime;
      if (url.pathname.startsWith('/api/')) {
        if (!service?.application)
          throw failure('database_unavailable', 'Application persistence is not configured.', 503);
        const result = await service.application.route(
          req,
          res,
          url,
          mutation ? await readBody(req) : undefined,
        );
        if (!result?.file) return json(200, result);
        handle = result.file;
        mime = result.mime;
      } else {
        if (mutation) return json(404, { error: 'Not found.' });
        const relative = decodeURIComponent(
          matchRoute(url.pathname) ? 'index.html' : url.pathname.slice(1),
        );
        if (relative !== 'index.html' && !/^assets\/[a-zA-Z0-9_.-]+\.(?:js|css)$/.test(relative))
          return json(404, { error: 'Not found.' });
        handle = await openSafe(publicDir, relative);
        if (relative === 'index.html') {
          const nonce = randomBytes(24).toString('base64');
          const html = (await handle.readFile('utf8').finally(() => handle.close())).replace(
            '</head>',
            `<meta name="csp-nonce" content="${nonce}"></head>`,
          );
          res.setHeader(
            'Content-Security-Policy',
            `default-src 'self'; img-src 'self'; style-src 'self' 'nonce-${nonce}'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
          );
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': Buffer.byteLength(html),
          });
          return res.end(req.method === 'HEAD' ? undefined : html);
        }
        mime = relative.endsWith('.css') ? 'text/css' : 'text/javascript';
      }
      const info = await handle.stat();
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': info.size });
      if (req.method === 'HEAD') {
        await handle.close();
        return res.end();
      }
      pipeline(handle.createReadStream(), res, () => {});
    } catch (error) {
      if (error.code === 'ENOENT') return json(404, { error: 'Not found.' });
      if (error instanceof URIError) return json(400, { error: 'Invalid URL encoding.' });
      const problem = publicError(error);
      if (!error.statusCode)
        console.error('Request failed:', req.correlationId, error.code || 'internal_error');
      json(error.statusCode || 500, { error: problem.message, code: problem.code });
    }
  });
}
