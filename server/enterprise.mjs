import path from 'node:path';
import { database, databaseError } from './db.mjs';
import { authentication, administration, keys, requirePermission, uuid } from './auth.mjs';
import { batchOperations } from './batches.mjs';
import { captureStorage } from './capture-storage.mjs';
import { failure } from './errors.mjs';
import { ocrProcessing } from './ocr.mjs';
import { qualityControl } from './qc.mjs';
import { approvals } from './approvals.mjs';
import { viewerWorkspace } from './viewer.mjs';
import { isViewer, viewerAudit } from './viewer-audit.mjs';
import { staffNotifications } from './notifications.mjs';

export function enterprise({
  scanner,
  dataDir,
  pool = database(),
  storageRoot = process.env.DIGITALARCH_STORAGE_ROOT || path.join(dataDir, 'managed'),
  ocr: ocrOptions = {},
}) {
  const auth = authentication(pool);
  const notifications = staffNotifications(pool, auth);
  const admin = administration(pool, auth);
  const storage = captureStorage(storageRoot);
  let lock;
  let initialization;
  let timer;
  let sweeping = false;
  let closed = false;
  const ocr = ocrProcessing(pool, storage, { ...ocrOptions, allowed: () => !!lock && !closed });
  const qc = qualityControl(pool, storage);
  const approval = approvals(pool, storage);
  const viewer = viewerWorkspace(pool, storage, auth, dataDir);
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
          notifications.disconnect();
          ocr.interrupt();
          initialization = null;
          lock = null;
          connection.release(true);
        });
        await notifications.listen(connection);
        await ocr.initializeDefaults();
        await viewer.initialize();
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
    approval,
    viewer,
    notifications,
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
          await viewer.sweep();
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
      await notifications.close();
      await ocr.close();
      while (sweeping) await new Promise((resolve) => setTimeout(resolve, 10));
      await viewer.close();
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
      let routeUser;
      try {
        await ensure();
        const pathname = url.pathname;
        const method = req.method === 'HEAD' ? 'GET' : req.method;
        if (pathname === '/api/auth/login' && method === 'POST')
          return await auth.login(body, res, req.correlationId);
        if (pathname === '/api/auth/register' && method === 'POST')
          return await viewer.register(body, req.correlationId);
        const context = await auth.authenticate(req);
        const user = { ...context.user, correlationId: req.correlationId };
        routeUser = user;
        context.user = user;
        if (method !== 'GET') auth.csrf(req, context.session);
        if (pathname === '/api/auth/me' && method === 'GET')
          return { user: context.user, csrfToken: context.csrfToken };
        if (
          method !== 'GET' &&
          !/^\/api\/batches\/[^/]+\/cancel-scan$/.test(pathname) &&
          (await batches.running(user))
        )
          throw failure(
            'scan_in_progress',
            'Capture is in progress. Only Cancel scan is available until capture and page reconciliation finish.',
            409,
          );
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
        if (pathname === '/api/notifications/stream' && method === 'GET')
          return notifications.stream(req, res, user);
        if (pathname === '/api/notifications/summary' && method === 'GET')
          return await notifications.summary(user);
        if (pathname === '/api/notifications') {
          if (method === 'GET') return await notifications.list(user, url.searchParams);
          if (method === 'POST') return await notifications.update(user, null, body);
        }
        const notification = pathname.match(/^\/api\/notifications\/([^/]+)$/);
        if (notification && method === 'POST')
          return await notifications.update(user, notification[1], body);
        if (pathname === '/api/admin/viewer-registrations' && method === 'GET')
          return await viewer.registrations(user, url.searchParams.get('status') || 'pending');
        const registration = pathname.match(/^\/api\/admin\/viewer-registrations\/([^/]+)$/);
        if (registration && method === 'POST')
          return await viewer.decideRegistration(user, registration[1], body);
        if (pathname === '/api/viewer/documents' && method === 'GET')
          return await viewer.list(user, {
            ...Object.fromEntries(
              ['search', 'type', 'sort', 'direction']
                .filter((key) => url.searchParams.has(key))
                .map((key) => [key, url.searchParams.get(key)]),
            ),
            limit: numeric(url.searchParams.get('limit'), 25, 100),
            offset: numeric(url.searchParams.get('offset'), 0, 1_000_000),
          });
        if (pathname === '/api/viewer/activity' && method === 'POST')
          return await viewer.activity(user, body);
        const viewerDocument = pathname.match(
          /^\/api\/viewer\/documents\/([^/]+)(?:\/(downloads))?$/,
        );
        if (viewerDocument) {
          if (method === 'GET' && !viewerDocument[2])
            return await viewer.get(user, viewerDocument[1]);
          if (method === 'POST' && viewerDocument[2])
            return await viewer.download(user, viewerDocument[1], body);
        }
        const viewerPage = pathname.match(
          /^\/api\/viewer\/documents\/([^/]+)\/pages\/([^/]+)\/(image|preview|thumbnail)$/,
        );
        if (viewerPage && method === 'GET') return await viewer.page(user, ...viewerPage.slice(1));
        const viewerDownload = pathname.match(/^\/api\/viewer\/downloads\/([^/]+)$/);
        if (viewerDownload && method === 'GET') {
          return await viewer.downloadStatus(user, viewerDownload[1]);
        }
        const viewerTransfer = pathname.match(/^\/api\/viewer\/downloads\/([^/]+)\/transfer$/);
        if (viewerTransfer && method === 'POST') {
          keys(body, []);
          return await viewer.downloadStatus(user, viewerTransfer[1], true);
        }
        const viewerReport = pathname.match(/^\/api\/viewer\/downloads\/([^/]+)\/report$/);
        if (viewerReport && method === 'POST')
          return await viewer.reportDownload(user, viewerReport[1], body);
        if (pathname === '/api/settings/approval') {
          if (method === 'GET') return await approval.settings(user);
          if (method === 'PATCH') return await approval.updateSettings(user, body);
        }
        if (pathname === '/api/records' && method === 'GET')
          return await approval.list(user, {
            ...Object.fromEntries(
              [
                'view',
                'search',
                'status',
                'type',
                'number',
                'location',
                'operator',
                'reviewer',
                'authority',
                'from',
                'to',
                'ocr',
                'metadata',
                'sort',
                'direction',
              ]
                .filter((key) => url.searchParams.has(key))
                .map((key) => [key, url.searchParams.get(key)]),
            ),
            limit: numeric(url.searchParams.get('limit'), 25, 100),
            offset: numeric(url.searchParams.get('offset'), 0, 1_000_000),
          });
        if (pathname === '/api/approval-notifications' && method === 'GET')
          return await approval.notifications(user);
        const confirmation = pathname.match(/^\/api\/confirmations\/([^/]+)(?:\/(qr|dismiss))?$/);
        if (confirmation) {
          if (method === 'GET' && !confirmation[2])
            return await approval.confirmation(user, confirmation[1]);
          if (method === 'GET' && confirmation[2] === 'qr')
            return await approval.qr(user, confirmation[1], url.origin);
          if (method === 'POST' && confirmation[2] === 'dismiss')
            return await approval.dismiss(user, confirmation[1], body);
        }
        const record = pathname.match(/^\/api\/records\/([^/]+)(?:\/(decision))?$/);
        if (record) {
          if (method === 'GET' && !record[2]) return await approval.get(user, record[1]);
          if (method === 'POST' && record[2]) return await approval.decide(user, record[1], body);
        }
        const recordPage = pathname.match(
          /^\/api\/records\/([^/]+)\/pages\/([^/]+)\/(preview|thumbnail|image|text)$/,
        );
        if (recordPage && method === 'GET')
          return await approval.page(user, ...recordPage.slice(1));
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
          const search = (url.searchParams.get('search') || '').trim();
          if (search.length > 240) throw failure('invalid_request', 'Search is too long.');
          return await ocr.list(user, {
            status: url.searchParams.get('status') || '',
            search,
            sort: url.searchParams.get('sort') || 'created_at',
            direction: url.searchParams.get('direction') || 'desc',
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
        if (pathname === '/api/admin/users/bulk' && method === 'POST') {
          permit(body?.action === 'delete' ? 'users:delete' : 'users:update');
          return await admin.bulk(user, body);
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
            return await admin.reset(user, account[1], body);
          }
        }
        if (pathname === '/api/admin/audit-logs' && method === 'GET') {
          permit('audit:read');
          return await admin.logs(
            numeric(url.searchParams.get('limit'), 100, 200),
            numeric(url.searchParams.get('offset'), 0, 1_000_000),
            {
              category: url.searchParams.get('category') || 'all',
              search: url.searchParams.get('search') || '',
            },
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
          return {
            ...(await scanner.forUser(user.id)).refreshIfNeeded(),
            capture: await batches.running(user),
          };
        }
        if (pathname === '/api/scanner/mode' && method === 'POST') {
          permit('scanner:configure');
          keys(body, ['mode']);
          return await (await scanner.forUser(user.id)).setMode(body.mode);
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
          return await (await scanner.forUser(user.id)).refresh(body);
        }
        if (
          ['/api/scanner/reserve', '/api/scanner/release'].includes(pathname) &&
          method === 'POST'
        ) {
          permit('scanner:scan');
          keys(body, []);
          const selected = await scanner.forUser(user.id);
          return await (pathname.endsWith('/reserve') ? selected.reserve() : selected.release());
        }
        if (pathname === '/api/batches') {
          if (method === 'POST') {
            permit('batches:create');
            return await batches.create(user, body);
          }
          if (method === 'GET') {
            if (!user.permissions.includes('batches:read_all')) permit('batches:read');
            const status = url.searchParams.get('status') || '';
            if (
              ![
                '',
                'in_progress',
                'paused',
                'capture_completed',
                'cancelled',
                'rework',
                'submitted',
                'completed',
              ].includes(status)
            )
              throw failure('invalid_status', 'Invalid batch status.');
            const search = url.searchParams.get('search') || '';
            if (search.length > 240) throw failure('invalid_request', 'Search is too long.');
            return await batches.list(user, {
              search,
              status,
              sort:
                url.searchParams.get('sort') ||
                (status === 'rework' ? 'returned_at' : 'updated_at'),
              direction: url.searchParams.get('direction') || 'desc',
              limit: numeric(url.searchParams.get('limit'), 25, 100),
              offset: numeric(url.searchParams.get('offset'), 0, 1_000_000),
            });
          }
        }
        const batch = pathname.match(
          /^\/api\/batches\/([^/]+)(?:\/(resume|pause|complete-capture|submit-qc|resubmit-qc|cancel|cancel-scan|scan-sessions|pages|reassign|delete|ocr|replacement|reorder))?$/,
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
            if (!user.permissions.includes('batches:update')) permit('qc:review');
            return await batches.location(user, id, body);
          }
          if (method === 'POST') {
            if (operation === 'cancel-scan') {
              permit('batches:update');
              return await batches.cancelScan(user, id, body);
            }
            if (operation === 'replacement' || operation === 'reorder') {
              permit('batches:update');
              return await batches[operation](user, id, body);
            }
            if (operation === 'submit-qc' || operation === 'resubmit-qc') {
              permit('batches:complete_capture');
              return await batches.submit(user, id, body, operation === 'resubmit-qc');
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
        if (isViewer(routeUser) && [403, 404].includes(error.statusCode))
          await viewerAudit(pool, 'access', routeUser, 'access_denied', {
            metadata: { path: url.pathname.slice(0, 256), method: req.method, code: error.code },
          });
        throw databaseError(error);
      }
    },
  };
}
