import path from 'node:path';
import { database, databaseError } from './db.mjs';
import { authentication, administration, keys, requirePermission, uuid } from './auth.mjs';
import { batchOperations } from './batches.mjs';
import { captureStorage } from './capture-storage.mjs';
import { failure } from './errors.mjs';
import { ocrProcessing } from './ocr.mjs';
import { qualityControl } from './qc.mjs';

export function enterprise({
  scanner,
  dataDir,
  pool = database(),
  storageRoot = process.env.DIGITALARCH_STORAGE_ROOT || path.join(dataDir, 'managed'),
  ocr: ocrOptions = {},
}) {
  const auth = authentication(pool);
  const admin = administration(pool, auth);
  const storage = captureStorage(storageRoot);
  let lock;
  let initialization;
  let timer;
  let sweeping = false;
  let closed = false;
  const ocr = ocrProcessing(pool, storage, { ...ocrOptions, allowed: () => !!lock && !closed });
  const qc = qualityControl(pool, storage);
  const batches = batchOperations(pool, scanner, storage, {
    ocrLanguage: null,
    ocrConfig: null,
  });
  async function ensure() {
    if (initialization) return initialization;
    initialization = (async () => {
      const connection = await pool.connect();
      try {
        const acquired = (
          await connection.query(
            "SELECT pg_try_advisory_lock(hashtext('digitalarch:runtime'),hashtext(current_database()||current_schema())) AS acquired",
          )
        ).rows[0].acquired;
        if (!acquired)
          throw failure(
            'runtime_busy',
            'Another DigitalArch process is using this database. Run only one backend per scanner.',
            503,
          );
        await connection.query('SELECT id FROM archive_batches LIMIT 1');
        lock = connection;
        lock.on('error', () => {
          ocr.interrupt();
          initialization = null;
          lock = null;
          connection.release(true);
        });
        await ocr.initializeDefaults();
        await batches.recover();
        ocr.start();
      } catch (error) {
        await connection
          .query(
            "SELECT pg_advisory_unlock(hashtext('digitalarch:runtime'),hashtext(current_database()||current_schema()))",
          )
          .catch(() => {});
        connection.release(true);
        lock = null;
        throw error;
      }
    })();
    try {
      await initialization;
    } catch (error) {
      initialization = null;
      throw error;
    }
  }
  const numeric = (value, fallback, max) => {
    if (value === null) return fallback;
    if (!/^\d+$/.test(value) || Number(value) > max)
      throw failure('invalid_request', 'Invalid pagination value.');
    return Number(value);
  };
  return {
    pool,
    auth,
    admin,
    batches,
    storage,
    ocr,
    qc,
    ready: ensure,
    async start() {
      try {
        await ensure();
      } catch {
        console.error(
          'Database unavailable or runtime already active. APIs will remain blocked until PostgreSQL is ready. Run pnpm db:status and pnpm db:migrate.',
        );
      }
      timer = setInterval(async () => {
        if (sweeping || closed) return;
        sweeping = true;
        try {
          await ensure();
          await batches.sweep();
          await qc.refresh();
        } catch {
          /* Retry without deleting spool or managed originals. */
        } finally {
          sweeping = false;
        }
      }, 500);
      timer.unref();
    },
    async close() {
      closed = true;
      clearInterval(timer);
      await ocr.close();
      while (sweeping) await new Promise((resolve) => setTimeout(resolve, 10));
      await storage.close();
      // Close only after any final page transaction releases its client.
      if (lock) {
        await lock
          .query(
            "SELECT pg_advisory_unlock(hashtext('digitalarch:runtime'),hashtext(current_database()||current_schema()))",
          )
          .catch(() => {});
        lock.release();
        lock = null;
      }
      await pool.end();
    },
    async route(req, res, url, body) {
      try {
        await ensure();
        const pathname = url.pathname;
        const method = req.method === 'HEAD' ? 'GET' : req.method;
        if (pathname === '/api/auth/login' && method === 'POST')
          return await auth.login(body, res, req.correlationId);
        const context = await auth.authenticate(req);
        const user = { ...context.user, correlationId: req.correlationId };
        context.user = user;
        if (method !== 'GET') auth.csrf(req, context.session);
        if (pathname === '/api/auth/me' && method === 'GET')
          return { user: context.user, csrfToken: context.csrfToken };
        if (pathname === '/api/auth/logout' && method === 'POST') {
          keys(body, []);
          return await auth.logout(context, res);
        }
        if (pathname === '/api/auth/change-password' && method === 'POST')
          return await auth.changePassword(context, body, res);
        if (user.must_change_password)
          throw failure(
            'password_change_required',
            'Change your temporary password before opening a workspace.',
            403,
          );
        const permit = (permission) => requirePermission(user, permission);
        if (pathname === '/api/qc/queue' && method === 'GET')
          return await qc.queue(user, {
            filter: url.searchParams.get('filter') || 'waiting',
            search: url.searchParams.get('search') || '',
            metadata: url.searchParams.get('metadata') || '',
            ocr: url.searchParams.get('ocr') || '',
            sort: url.searchParams.get('sort') || 'updated_at',
            direction: url.searchParams.get('direction') || 'desc',
            limit: numeric(url.searchParams.get('limit'), 25, 100),
            offset: numeric(url.searchParams.get('offset'), 0, 1_000_000),
          });
        const qcRoute = pathname.match(
          /^\/api\/qc\/([^/]+)(?:\/(claim|release|reassign|heartbeat|save|pass|return|findings|page-review|page-edit|correct-text|policy|reprocess-ocr))?$/,
        );
        if (qcRoute) {
          const [, id, action] = qcRoute;
          if (method === 'GET' && !action) return await qc.get(user, id);
          if (method === 'POST') {
            if (action === 'claim') return await qc.claim(user, id, body);
            if (action === 'release' || action === 'reassign')
              return await qc.release(user, id, body, action === 'reassign');
            if (action === 'heartbeat') return await qc.heartbeat(user, id, body);
            if (action === 'save') return await qc.save(user, id, body);
            if (action === 'pass' || action === 'return')
              return await qc.decision(user, id, body, action === 'pass');
            if (action === 'findings') return await qc.finding(user, id, body);
            if (action === 'page-review') return await qc.pageReview(user, id, body);
            if (action === 'page-edit') return await qc.pageEdit(user, id, body);
            if (action === 'correct-text') return await qc.correctText(user, id, body);
            if (action === 'reprocess-ocr') return await qc.reprocess(user, id, body);
            if (action === 'policy') return await qc.policy(user, id, body);
          }
        }
        const qcPage = pathname.match(/^\/api\/qc\/([^/]+)\/pages\/([^/]+)$/);
        if (qcPage && method === 'GET') return await qc.pageInfo(user, qcPage[1], qcPage[2]);
        const revisionImage = pathname.match(
          /^\/api\/qc\/([^/]+)\/pages\/([^/]+)\/revisions\/([^/]+)\/(image|preview)$/,
        );
        if (revisionImage && method === 'GET')
          return await qc.revisionImage(user, ...revisionImage.slice(1));
        const documentMetadata = pathname.match(
          /^\/api\/batches\/([^/]+)\/metadata(?:\/(extract))?$/,
        );
        if (documentMetadata) {
          if (method === 'GET' && !documentMetadata[2])
            return await qc.metadata(user, documentMetadata[1]);
          if (method === 'PATCH' && !documentMetadata[2])
            return await qc.metadata(user, documentMetadata[1], body);
          if (method === 'POST' && documentMetadata[2])
            return await qc.metadata(user, documentMetadata[1], body, true);
        }
        if (pathname === '/api/settings/ocr') {
          if (method === 'GET') return await ocr.getSettings(user);
          if (method === 'PATCH') return await ocr.updateSettings(user, body);
        }
        if (pathname === '/api/ocr/defaults' && method === 'GET')
          return await ocr.currentDefaults(user);
        if (pathname === '/api/ocr/engines' && method === 'GET') return await ocr.engines(user);
        if (pathname === '/api/ocr/jobs' && method === 'GET') {
          return await ocr.list(user, {
            status: url.searchParams.get('status') || '',
            limit: numeric(url.searchParams.get('limit'), 25, 100),
            offset: numeric(url.searchParams.get('offset'), 0, 1_000_000),
          });
        }
        const ocrJob = pathname.match(
          /^\/api\/ocr\/jobs\/([^/]+)(?:\/(pages|pause|resume|cancel|retry-failed|reprocess))?$/,
        );
        const ocrImage = pathname.match(
          /^\/api\/ocr\/jobs\/([^/]+)\/pages\/([^/]+)\/(image|preview)$/,
        );
        const metadata = pathname.match(/^\/api\/ocr\/jobs\/([^/]+)\/metadata(?:\/(extract))?$/);
        if (metadata && method === 'GET' && !metadata[2])
          return await ocr.metadata.get(user, metadata[1]);
        if (metadata && ['POST', 'PATCH'].includes(method)) {
          await ocr.metadata.get(user, metadata[1]);
          throw failure(
            'metadata_moved',
            'OCR-run metadata is a historical snapshot. Edit document metadata in the Document / QC workspace.',
            409,
          );
        }
        if (ocrImage && method === 'GET') return await ocr.image(user, ...ocrImage.slice(1));
        if (ocrJob) {
          const [, id, action] = ocrJob;
          if (method === 'POST' && action === 'reprocess')
            return await ocr.reprocess(user, id, body);
          if (method === 'GET' && !action) return await ocr.get(user, id);
          if (method === 'GET' && action === 'pages')
            return await ocr.pages(user, id, {
              limit: numeric(url.searchParams.get('limit'), 25, 100),
              offset: numeric(url.searchParams.get('offset'), 0, 1_000_000),
            });
          if (method === 'POST' && action && action !== 'pages')
            return await ocr.control(user, id, action, body);
        }
        const pageOcr = pathname.match(/^\/api\/pages\/([^/]+)\/ocr$/);
        if (pageOcr && method === 'GET') return await ocr.page(user, pageOcr[1]);
        if (pathname === '/api/admin/users') {
          if (method === 'GET') {
            permit('users:read');
            return await admin.list();
          }
          if (method === 'POST') {
            permit('users:create');
            permit('roles:assign');
            return await admin.create(user, body);
          }
        }
        const account = pathname.match(/^\/api\/admin\/users\/([^/]+)(\/reset-password)?$/);
        if (account) {
          uuid(account[1]);
          if (method === 'PATCH' && !account[2]) {
            permit('users:update');
            if (body.roles !== undefined) permit('roles:assign');
            if (body.isActive !== undefined) permit('users:disable');
            return await admin.update(user, account[1], body);
          }
          if (method === 'POST' && account[2]) {
            permit('users:update');
            keys(body, []);
            return await admin.reset(user, account[1]);
          }
        }
        if (pathname === '/api/admin/audit-logs' && method === 'GET') {
          permit('audit:read');
          return await admin.logs(
            numeric(url.searchParams.get('limit'), 100, 200),
            numeric(url.searchParams.get('offset'), 0, 1_000_000),
          );
        }
        if (pathname === '/api/admin/system' && method === 'GET') {
          permit('system:read');
          const info = (
            await pool.query(
              "SELECT version(),(SELECT extversion FROM pg_extension WHERE extname='vector') AS vector,current_setting('TimeZone') AS timezone",
            )
          ).rows[0];
          return {
            ...info,
            persistence: 'PostgreSQL metadata + managed PNG filesystem',
            scannerArchitecture: 'Node → Windows bridge → .NET 8 → NAPS2 → WIA',
            deployment: 'One local backend; loopback-only',
          };
        }
        if (pathname === '/api/scanner/status' && method === 'GET') {
          permit('scanner:read');
          return scanner.status();
        }
        if (pathname === '/api/scanner/mode' && method === 'POST') {
          permit('scanner:configure');
          keys(body, ['mode']);
          return await scanner.setMode(body.mode);
        }
        if (pathname === '/api/scanner/refresh' && method === 'POST') {
          permit('scanner:configure');
          keys(body, ['profileId', 'deviceId']);
          if (
            Object.values(body).some(
              (value) => value !== null && (typeof value !== 'string' || value.length > 512),
            )
          )
            throw failure('invalid_request', 'Invalid scanner selection.');
          await scanner.refresh(body);
          return scanner.status();
        }
        if (pathname === '/api/batches') {
          if (method === 'POST') {
            permit('batches:create');
            return await batches.create(user, body);
          }
          if (method === 'GET') {
            if (!user.permissions.includes('batches:read_all')) permit('batches:read');
            const status = url.searchParams.get('status') || '';
            if (!['', 'in_progress', 'paused', 'capture_completed', 'cancelled'].includes(status))
              throw failure('invalid_status', 'Invalid batch status.');
            const search = url.searchParams.get('search') || '';
            if (search.length > 240) throw failure('invalid_request', 'Search is too long.');
            return await batches.list(user, {
              search,
              status,
              sort: url.searchParams.get('sort') || 'updated_at',
              direction: url.searchParams.get('direction') || 'desc',
              limit: numeric(url.searchParams.get('limit'), 25, 100),
              offset: numeric(url.searchParams.get('offset'), 0, 1_000_000),
            });
          }
        }
        const batch = pathname.match(
          /^\/api\/batches\/([^/]+)(?:\/(resume|pause|complete-capture|resubmit-qc|cancel|scan-sessions|pages|reassign|delete|ocr|replacement|reorder))?$/,
        );
        if (batch) {
          const [, id, operation] = batch;
          uuid(id);
          if (method === 'GET') {
            if (operation && !['pages', 'scan-sessions'].includes(operation))
              throw failure('not_found', 'Operation not found.', 404);
            if (!user.permissions.includes('batches:read_all')) permit('batches:read');
            const result = await batches.get(user, id);
            return operation === 'pages'
              ? { pages: result.pages }
              : operation === 'scan-sessions'
                ? { sessions: result.sessions }
                : result;
          }
          if (method === 'PATCH' && !operation) {
            permit('batches:update');
            return await batches.location(user, id, body);
          }
          if (method === 'POST') {
            if (operation === 'replacement' || operation === 'reorder') {
              permit('batches:update');
              return await batches[operation](user, id, body);
            }
            if (operation === 'resubmit-qc') {
              permit('batches:complete_capture');
              const current = await batches.get(user, id);
              if (current.batch.workflow_status !== 'rework')
                throw failure('workflow_locked', 'This batch is not in rework.', 409);
              return await batches.transition(user, id, 'complete-capture', body);
            }
            if (operation === 'ocr') return await ocr.enqueue(user, id, body);
            if (!operation || operation === 'pages')
              throw failure('not_found', 'Operation not found.', 404);
            if (operation === 'scan-sessions') {
              permit('batches:update');
              return await batches.start(user, id, body);
            }
            if (operation === 'reassign') {
              permit('batches:reassign');
              return await batches.reassign(user, id, body);
            }
            if (operation === 'delete') {
              permit('batches:delete');
              return await batches.remove(user, id, body);
            }
            permit(
              {
                resume: 'batches:resume',
                pause: 'batches:pause',
                'complete-capture': 'batches:complete_capture',
                cancel: 'batches:update',
              }[operation],
            );
            return await batches.transition(user, id, operation, body);
          }
        }
        const pageEdit = pathname.match(/^\/api\/pages\/([^/]+)$/);
        if (pageEdit && method === 'PATCH') {
          permit('batches:update');
          return await batches.editPage(user, pageEdit[1], body);
        }
        const page = pathname.match(/^\/api\/pages\/([^/]+)\/(image|thumbnail|preview|original)$/);
        if (page && method === 'GET') {
          if (!user.permissions.includes('batches:read_all')) permit('batches:read');
          const record = await batches.page(user, page[1]);
          const handle = ['image', 'original'].includes(page[2])
            ? await storage.open(
                page[2] === 'original' ? record.original_storage_key : record.active_storage_key,
              )
            : await storage.derivative(record, page[2]);
          return {
            file: handle,
            mime: ['image', 'original'].includes(page[2]) ? 'image/png' : 'image/webp',
          };
        }
        throw failure('not_found', 'Operation not found.', 404);
      } catch (error) {
        throw databaseError(error);
      }
    },
  };
}
