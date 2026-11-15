import http from 'node:http';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { pipeline, Transform } from 'node:stream';
import { openSafe } from './storage.mjs';
import { failure, publicError } from './errors.mjs';
import { matchRoute } from '../src/routes.js';

async function readBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    const max = /\/correct-text$/.test(req.url)
      ? 4 * 1024 * 1024
      : /\/metadata(?:\/extract)?$/.test(req.url)
        ? 1024 * 1024
        : 64 * 1024;
    if (length > max) throw failure('invalid_request', 'Request body too large.', 413);
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
    let complete;
    let bytesRead = 0;
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
      let encoded = false;
      if (url.pathname.startsWith('/api/')) {
        if (!service?.application)
          throw failure('database_unavailable', 'Application persistence is not configured.', 503);
        const result = await service.application.route(
          req,
          res,
          url,
          mutation ? await readBody(req) : undefined,
        );
        if (result?.streaming) return;
        if (result?.onComplete) {
          let called = false;
          const started = Date.now();
          complete = (success) => {
            if (called) return;
            called = true;
            result
              .onComplete(success, {
                durationMs: Date.now() - started,
                bytesRead,
                serverReported: true,
              })
              .catch(() => console.error('Download outcome audit unavailable:', req.correlationId));
          };
          res.once('finish', () => complete(true));
          res.once('close', () => complete(false));
        }
        if (result?.buffer) {
          res.writeHead(200, {
            'Content-Type': result.mime,
            'Content-Length': result.buffer.length,
          });
          return res.end(req.method === 'HEAD' ? undefined : result.buffer);
        }
        if (!result?.file) return json(200, result);
        handle = result.file;
        mime = result.mime;
        encoded = !!result.encoded;
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
      res.writeHead(200, {
        'Content-Type': mime,
        ...(encoded ? { 'X-Document-Bytes': info.size } : { 'Content-Length': info.size }),
      });
      if (req.method === 'HEAD') {
        await handle.close();
        return res.end();
      }
      const stream = handle.createReadStream({ highWaterMark: 64 * 1024 });
      if (complete)
        stream.on('data', (chunk) => {
          bytesRead += chunk.length;
        });
      if (encoded) {
        const packets = new Transform({
          transform(chunk, _encoding, callback) {
            callback(null, JSON.stringify({ data: chunk.toString('base64') }) + '\n');
          },
        });
        pipeline(stream, packets, res, () => {});
      } else pipeline(stream, res, () => {});
    } catch (error) {
      complete?.(false);
      if (res.headersSent) return res.destroy();
      if (error.code === 'ENOENT') return json(404, { error: 'Not found.' });
      if (error instanceof URIError) return json(400, { error: 'Invalid URL encoding.' });
      const problem = publicError(error);
      if (!error.statusCode)
        console.error('Request failed:', req.correlationId, error.code || 'internal_error');
      json(error.statusCode || 500, { error: problem.message, code: problem.code });
    }
  });
}
