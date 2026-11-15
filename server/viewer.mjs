import path from 'node:path';
import { mkdir, open, unlink } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { keys, passwordHash, requirePermission, text, uuid } from './auth.mjs';
import { transaction } from './db.mjs';
import { failure } from './errors.mjs';
import { finalPublication } from './approvals.mjs';
import { viewerAudit } from './viewer-audit.mjs';
import { parsePageSelection } from '../src/viewerPages.js';
import { metadataTypes } from './metadata-extract.mjs';

const source = `FROM documents d JOIN archive_batches b ON b.id=d.batch_id
  JOIN qc_reviews r ON r.document_id=d.id AND r.cycle=d.review_cycle
  WHERE b.deleted_at IS NULL AND ${finalPublication}`;
const documentDate = `coalesce(d.document_date::text,(SELECT field->>'normalized'
  FROM jsonb_array_elements(coalesce(r.snapshot->'metadata'->'fields','[]'::jsonb)) field
  WHERE field->>'type'='date' AND field->>'normalized' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' LIMIT 1))`;
const basic = `d.id AS document_id,d.batch_id AS id,d.title,d.archive_number,d.document_type,
  ${documentDate} AS document_date,d.published_at,d.revision,jsonb_array_length(r.snapshot->'pages') AS page_count`;

export function viewerWorkspace(pool, storage, auth, dataDir) {
  const exportsDir = path.join(dataDir, 'viewer-exports');
  const downloads = new Map();
  let building = false,
    closed = false,
    registering = 0;
  let registrationWindow = 0,
    registrationCount = 0;
  async function published(client, user, id) {
    requirePermission(user, 'archive:read');
    uuid(id);
    const doc = (
      await client.query(
        `SELECT ${basic},r.snapshot,r.id AS publication_id ${source} AND d.batch_id=$1 ORDER BY d.document_index LIMIT 1`,
        [id],
      )
    ).rows[0];
    if (!doc) throw failure('not_found', 'Published document unavailable.', 404);
    return doc;
  }
  const auditDownload = (job, action, metadata = {}) =>
    viewerAudit(pool, 'download', job.user, action, {
      batchId: job.batchId,
      documentId: job.documentId,
      downloadId: job.id,
      metadata,
    });
  async function expire(job) {
    if (job.delivering) return;
    await auditDownload(job, 'expired');
    await unlink(job.file).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    downloads.delete(job.id);
  }
  async function imageKey(client, doc, saved) {
    const page = (
      await client.query('SELECT * FROM pages WHERE id=$1 AND batch_id=$2', [saved.id, doc.id])
    ).rows[0];
    const sha = saved.active_image_sha256;
    let key;
    if (page?.active_image_sha256 === sha) key = page.active_storage_key;
    else if (page?.sha256 === sha) key = page.original_storage_key;
    else
      key = (
        await client.query(
          'SELECT storage_key FROM page_revisions WHERE page_id=$1 AND sha256=$2 ORDER BY created_at LIMIT 1',
          [saved.id, sha],
        )
      ).rows[0]?.storage_key;
    if (!key) throw failure('snapshot_image_missing', 'The published image is unavailable.', 409);
    return { key, sha };
  }
  async function generate(job, doc, pages) {
    let pdf;
    let written;
    try {
      await mkdir(exportsDir, { recursive: true, mode: 0o700 });
      pdf = new PDFDocument({
        autoFirstPage: false,
        compress: true,
        info: { Producer: 'DigitalArch', Creator: 'DigitalArch' },
      });
      written = pipeline(pdf, createWriteStream(job.file, { flags: 'wx', mode: 0o600 }));
      written.catch(() => {});
      for (const saved of pages) {
        if (closed) throw new Error('shutdown');
        const currentUser = await auth.user(job.user.id);
        if (!currentUser?.is_active || !currentUser.permissions.includes('archive:read'))
          throw new Error('access_revoked');
        const current = await published(pool, currentUser, job.batchId);
        if (current.publication_id !== job.publicationId) throw new Error('publication_changed');
        const { key, sha } = await imageKey(pool, doc, saved);
        const buffer = await storage.ocrImage({ storage_key: key, image_sha256: sha });
        // Image conversion only: no OCR or resampling; JPEG keeps large PDFs bounded.
        const image = await sharp(buffer, { limitInputPixels: 100_000_000 })
          .rotate(saved.rotation_degrees || 0)
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: 95 })
          .toBuffer({ resolveWithObject: true });
        const dpi = saved.dpi || 300;
        const width = (image.info.width * 72) / dpi,
          height = (image.info.height * 72) / dpi;
        pdf.addPage({ size: [width, height], margin: 0 });
        pdf.image(image.data, 0, 0, { width, height });
        pdf.flushPages();
        job.processed++;
      }
      pdf.end();
      await written;
      const checksum = createHash('sha256');
      for await (const chunk of createReadStream(job.file)) checksum.update(chunk);
      const handle = await open(job.file, 'r');
      const bytes = (await handle.stat()).size;
      await handle.close();
      await auditDownload(job, 'prepared', {
        filename: job.filename,
        pageCount: pages.length,
        bytes,
        sha256: checksum.digest('hex'),
      });
      job.bytes = bytes;
      job.status = 'ready';
    } catch (error) {
      pdf?.destroy();
      await written?.catch(() => {});
      await unlink(job.file).catch(() => {});
      job.status = 'failed';
      job.error = 'PDF preparation failed or access changed. Retry from the library.';
      await auditDownload(job, 'failed', {
        reason: ['access_revoked', 'publication_changed', 'shutdown'].includes(error.message)
          ? error.message
          : 'generation_failed',
      });
    } finally {
      building = false;
      job.expires = Date.now() + 10 * 60_000;
    }
  }
  const api = {
    async initialize() {
      // Runtime-owned temporary files cannot be resumed after a restart.
      const unfinished = (
        await pool.query(
          `SELECT DISTINCT ON(download_id) * FROM viewer_download_audit ORDER BY download_id,sequence DESC`,
        )
      ).rows;
      for (const event of unfinished.filter(
        (e) =>
          !downloads.has(e.download_id) &&
          !['expired', 'failed', 'interrupted'].includes(e.action.split('.')[1]),
      )) {
        await viewerAudit(pool, 'download', { id: event.actor_id }, 'interrupted', {
          downloadId: event.download_id,
          batchId: event.batch_id,
          documentId: event.document_id,
        });
        await unlink(path.join(exportsDir, `${event.download_id}.pdf`)).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    },
    async close() {
      closed = true;
      await Promise.allSettled([...downloads.values()].map((job) => job.work));
      for (const job of downloads.values()) await expire(job);
    },
    async sweep() {
      for (const job of downloads.values()) {
        if (job.pendingOutcome && !job.delivering) {
          await auditDownload(job, job.pendingOutcome.action, job.pendingOutcome.metadata);
          job.pendingOutcome = null;
        }
        if (job.expires && job.expires < Date.now()) await expire(job);
      }
    },
    async register(body, correlationId) {
      keys(body, ['username', 'displayName', 'password', 'confirmPassword']);
      const username = text(body.username, 64, 'Username').toLowerCase();
      if (!/^[a-z0-9_.-]{3,64}$/.test(username))
        throw failure('invalid_username', 'Use 3–64 letters, digits, dots, dashes or underscores.');
      const displayName = text(body.displayName, 120, 'Full name');
      if (
        typeof body.password !== 'string' ||
        body.password.length < 12 ||
        body.password.length > 256 ||
        !body.password.trim() ||
        body.password !== body.confirmPassword
      )
        throw failure('invalid_password', 'Use matching passwords with 12–256 characters.');
      if (Date.now() - registrationWindow > 15 * 60_000) {
        registrationWindow = Date.now();
        registrationCount = 0;
      }
      if (registering >= 2 || registrationCount >= 10)
        throw failure(
          'rate_limited',
          'Too many registration requests. Try again in 15 minutes.',
          429,
        );
      registering++;
      registrationCount++;
      try {
        const hash = await passwordHash(body.password);
        await transaction(pool, async (client) => {
          const account = (
            await client.query(
              `INSERT INTO users(username,display_name,password_hash,is_active,must_change_password,viewer_registration_status)
            VALUES($1,$2,$3,false,false,'pending') RETURNING id`,
              [username, displayName, hash],
            )
          ).rows[0];
          await client.query(
            "INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='archive_viewer'",
            [account.id],
          );
          await viewerAudit(
            client,
            'registration',
            { id: account.id, correlationId },
            'submitted',
            { subjectId: account.id },
          );
        });
        return { registrationStatus: 'pending' };
      } catch (error) {
        if (error.code === '23505')
          throw failure(
            'username_unavailable',
            'This username is unavailable. Choose another.',
            409,
          );
        throw error;
      } finally {
        registering--;
      }
    },
    async registrations(user, status = 'pending') {
      requirePermission(user, 'viewers:approve');
      if (!['pending', 'approved', 'rejected'].includes(status))
        throw failure('invalid_request', 'Invalid registration status.');
      return {
        requests: (
          await pool.query(
            `SELECT id,username,display_name,viewer_registration_status,created_at,version FROM users
        WHERE viewer_registration_status=$1 AND deleted_at IS NULL ORDER BY created_at,id`,
            [status],
          )
        ).rows,
      };
    },
    async decideRegistration(user, id, body) {
      requirePermission(user, 'viewers:approve');
      uuid(id);
      keys(body, ['version', 'action']);
      if (!['approve', 'reject'].includes(body.action))
        throw failure('invalid_request', 'Choose Approve or Reject.');
      return transaction(pool, async (client) => {
        const account = (
          await client.query('SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [
            id,
          ])
        ).rows[0];
        if (
          !account ||
          account.viewer_registration_status !== 'pending' ||
          account.version !== body.version
        )
          throw failure('conflict', 'This registration changed. Refresh before deciding.', 409);
        const approve = body.action === 'approve';
        await client.query(
          'UPDATE users SET viewer_registration_status=$2,is_active=$3,version=version+1,updated_at=now() WHERE id=$1',
          [id, approve ? 'approved' : 'rejected', approve],
        );
        await viewerAudit(client, 'registration', user, approve ? 'approved' : 'rejected', {
          subjectId: id,
        });
        return { saved: true };
      });
    },
    async list(user, params) {
      requirePermission(user, 'archive:read');
      const search = text(params.search || '', 240, 'Search', true) || '';
      const type = text(params.type || '', 240, 'Document type', true) || '';
      const sorts = {
        title: 'd.title',
        published_at: 'd.published_at',
        document_date: 'document_date',
      };
      const sort = params.sort || 'published_at',
        direction = params.direction || 'desc';
      if (!Object.hasOwn(sorts, sort) || !['asc', 'desc'].includes(direction))
        throw failure('invalid_request', 'Invalid library sort.');
      const limit = params.limit ?? 25,
        offset = params.offset ?? 0;
      const where = `${source} AND ($1='' OR strpos(lower(concat_ws(' ',d.title,d.archive_number,d.document_type)),lower($1))>0)
        AND ($2='' OR lower(d.document_type)=lower($2))`;
      return transaction(pool, async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        const records = (
          await client.query(
            `SELECT ${basic},r.snapshot->'pages'->0->>'id' AS cover_page_id,
              coalesce((r.snapshot->'pages'->0->>'rotation_degrees')::integer,0) AS cover_rotation
              ${where} ORDER BY ${sorts[sort]} ${direction} NULLS LAST,d.id LIMIT $3 OFFSET $4`,
            [search, type, limit, offset],
          )
        ).rows;
        const total = (await client.query(`SELECT count(*)::int AS total ${where}`, [search, type]))
          .rows[0].total;
        const types = (
          await client.query(
            `SELECT DISTINCT d.document_type ${source} AND d.document_type IS NOT NULL ORDER BY d.document_type`,
          )
        ).rows.map((row) => row.document_type);
        await viewerAudit(client, 'activity', user, 'library_list', {
          metadata: { search, type, sort, direction, limit, offset, total },
        });
        return { records, total, types };
      });
    },
    async get(user, id) {
      return transaction(pool, async (client) => {
        const doc = await published(client, user, id);
        await viewerAudit(client, 'activity', user, 'document_opened', {
          batchId: id,
          documentId: doc.document_id,
          metadata: { revision: doc.revision },
        });
        const { snapshot, ...document } = doc;
        delete document.publication_id;
        return {
          document,
          metadata: (snapshot.metadata?.fields || [])
            .filter((field) => metadataTypes.includes(field.type) || field.type === 'document_type')
            .map(({ type, value, context }) => ({ type, value, context: context || '' })),
          pages: snapshot.pages.map((p, index) => ({
            id: p.id,
            number: index + 1,
            rotation: p.rotation_degrees || 0,
          })),
        };
      });
    },
    async page(user, id, pageId, size) {
      uuid(pageId);
      return transaction(pool, async (client) => {
        const doc = await published(client, user, id);
        const saved = doc.snapshot.pages.find((p) => p.id === pageId);
        if (!saved) throw failure('not_found', 'Page is not in the published document.', 404);
        const { key, sha } = await imageKey(client, doc, saved);
        await storage.ocrImage({ storage_key: key, image_sha256: sha });
        await viewerAudit(
          client,
          'activity',
          user,
          size === 'thumbnail' ? 'thumbnail_loaded' : 'page_viewed',
          {
            batchId: id,
            documentId: doc.document_id,
            metadata: { pageId, revision: doc.revision, size },
          },
        );
        return {
          file:
            size === 'image'
              ? await storage.open(key)
              : await storage.derivative({ active_storage_key: key }, size),
          mime: size === 'image' ? 'image/png' : 'image/webp',
        };
      });
    },
    async activity(user, body) {
      requirePermission(user, 'archive:read');
      keys(body, ['action', 'batchId', 'value']);
      if (
        ![
          'tab_opened',
          'tab_closed',
          'tab_selected',
          'page_selected',
          'view_changed',
          'layout_changed',
          'download_selection',
        ].includes(body.action)
      )
        throw failure('invalid_request', 'Invalid viewer action.');
      const value = text(body.value || '', 2000, 'Action value', true);
      let doc;
      if (body.batchId) {
        uuid(body.batchId);
        try {
          doc = await published(pool, user, body.batchId);
        } catch (error) {
          if (body.action !== 'tab_closed' || error.statusCode !== 404) throw error;
        }
      }
      await viewerAudit(pool, 'activity', user, body.action, {
        batchId: doc?.id,
        documentId: doc?.document_id,
        metadata: {
          value,
          ...(doc ? { revision: doc.revision } : {}),
          ...(!doc && body.batchId ? { requestedBatchId: body.batchId } : {}),
          clientReported: true,
        },
      });
      return { saved: true };
    },
    async download(user, id, body) {
      keys(body, ['revision', 'selection', 'range', 'currentPage']);
      const doc = await published(pool, user, id);
      if (body.revision !== doc.revision)
        throw failure('conflict', 'Publication changed. Reopen the document.', 409);
      if (!['current', 'selected', 'all'].includes(body.selection))
        throw failure('invalid_request', 'Choose pages to download.');
      let numbers;
      try {
        numbers =
          body.selection === 'all'
            ? doc.snapshot.pages.map((_, i) => i + 1)
            : parsePageSelection(
                body.selection === 'current' ? String(body.currentPage) : body.range,
                doc.page_count,
              );
      } catch (error) {
        throw failure('invalid_request', error.message);
      }
      if (!numbers.length) throw failure('invalid_request', 'No pages selected.');
      if (building || downloads.size >= 4)
        throw failure(
          'download_busy',
          'Another PDF is preparing or temporary storage is full. Try again shortly.',
          429,
        );
      const pages = numbers.map((n) => doc.snapshot.pages[n - 1]);
      const job = {
        id: randomUUID(),
        user,
        batchId: id,
        documentId: doc.document_id,
        revision: doc.revision,
        publicationId: doc.publication_id,
        status: 'preparing',
        processed: 0,
        total: pages.length,
      };
      job.file = path.join(exportsDir, `${job.id}.pdf`);
      job.filename = `document-${id.slice(0, 8)}-${body.selection}.pdf`;
      building = true;
      try {
        await auditDownload(job, 'requested', {
          revision: doc.revision,
          selection: body.selection,
          format: 'pdf',
          pages: pages.map((p, i) => ({
            id: p.id,
            number: numbers[i],
            sha256: p.active_image_sha256,
            rotation: p.rotation_degrees || 0,
          })),
          filename: job.filename,
        });
      } catch (error) {
        building = false;
        throw error;
      }
      downloads.set(job.id, job);
      job.work = generate(job, doc, pages).catch(() => {
        job.status = 'failed';
        job.error = 'Audit unavailable. PDF delivery blocked.';
      });
      return { id: job.id, status: job.status, total: job.total };
    },
    async downloadStatus(user, id, file = false) {
      requirePermission(user, 'archive:read');
      uuid(id);
      const job = downloads.get(id);
      if (!job || job.user.id !== user.id)
        throw failure('not_found', 'Download expired. Prepare a new PDF.', 404);
      const doc = await published(pool, user, job.batchId);
      if (doc.publication_id !== job.publicationId)
        throw failure('conflict', 'Publication changed. Prepare a new PDF.', 409);
      if (!file)
        return {
          id,
          status: job.status,
          processed: job.processed,
          total: job.total,
          error: job.error,
        };
      if (job.status !== 'ready') throw failure('not_ready', 'The PDF is not ready.', 409);
      if (job.delivering)
        throw failure('download_busy', 'This PDF is already being delivered.', 409);
      job.delivering = true;
      let handle;
      try {
        await auditDownload(job, 'delivery_started');
        handle = await open(job.file, 'r');
      } catch (error) {
        job.delivering = false;
        throw error;
      }
      return {
        file: handle,
        mime: 'application/vnd.digitalarch.transfer',
        encoded: true,
        onComplete: async (success, transfer) => {
          const action = success ? 'delivered' : 'delivery_failed';
          job.pendingOutcome = { action, metadata: transfer };
          try {
            await auditDownload(job, action, transfer);
            job.pendingOutcome = null;
          } finally {
            job.delivering = false;
            job.expires = Date.now() + 10 * 60_000;
          }
        },
      };
    },
    async reportDownload(user, id, body) {
      requirePermission(user, 'archive:read');
      uuid(id);
      keys(body, ['outcome', 'bytes', 'durationMs', 'saveMode']);
      const job = downloads.get(id);
      if (!job || job.user.id !== user.id) throw failure('not_found', 'Download expired.', 404);
      if (
        !['received', 'saved', 'cancelled', 'failed'].includes(body.outcome) ||
        !['file', 'browser'].includes(body.saveMode) ||
        !Number.isSafeInteger(body.bytes) ||
        body.bytes < 0 ||
        body.bytes > (job.bytes || 0) ||
        !Number.isSafeInteger(body.durationMs) ||
        body.durationMs < 0 ||
        body.durationMs > 7 * 24 * 60 * 60 * 1000
      )
        throw failure('invalid_request', 'Invalid download transfer report.');
      if (['received', 'saved'].includes(body.outcome) && body.bytes !== job.bytes)
        throw failure('invalid_request', 'The transfer is incomplete.');
      await auditDownload(job, 'transfer_reported', { ...body, clientReported: true });
      return { saved: true };
    },
  };
  return api;
}
