import { randomBytes, randomUUID } from 'node:crypto';
import { transaction } from './db.mjs';
import { audit, keys, requirePermission, text, uuid } from './auth.mjs';
import { failure } from './errors.mjs';
import { listPages } from './storage.mjs';

export function batchCode(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jakarta',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return `B-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

const summary = `SELECT b.*,u.display_name AS assigned_operator,
  (SELECT count(*)::int FROM pages p WHERE p.batch_id=b.id AND NOT p.is_excluded) AS page_count,
  (SELECT count(*)::int FROM scan_sessions s WHERE s.batch_id=b.id) AS session_count,
  (SELECT count(*)::int FROM scan_sessions s WHERE s.batch_id=b.id AND s.status='completed') AS completed_sessions,
  (SELECT j.id FROM ocr_jobs j WHERE j.batch_id=b.id ORDER BY j.created_at DESC,j.id DESC LIMIT 1) AS ocr_job_id
  FROM archive_batches b LEFT JOIN users u ON u.id=b.assigned_operator_id`;

export function batchOperations(
  pool,
  scanner,
  storage,
  { ocrLanguage = 'ind+eng', ocrConfig } = {},
) {
  const working = new Map();
  function ownership(user, batch, write = false) {
    if (!batch || batch.deleted_at) throw failure('not_found', 'Batch not found.', 404);
    if (
      batch.assigned_operator_id !== user.id &&
      (write || !user.permissions.includes('batches:read_all'))
    )
      throw failure('forbidden', 'This batch is assigned to another operator.', 403);
  }
  function version(batch, value) {
    if (!Number.isSafeInteger(value) || batch.version !== value)
      throw failure(
        'conflict',
        'This batch changed in another tab. Reload before continuing.',
        409,
      );
  }
  const mutable = (batch) => {
    if (batch.deleted_at) throw failure('not_found', 'Batch not found.', 404);
    if (!['in_progress', 'paused'].includes(batch.status))
      throw failure(
        'batch_locked',
        'Capture-completed or cancelled batches cannot be modified.',
        409,
      );
  };
  async function noRunning(client, id) {
    if (
      (
        await client.query(
          "SELECT 1 FROM scan_sessions WHERE batch_id=$1 AND (status='running' OR recovery_pending)",
          [id],
        )
      ).rowCount
    )
      throw failure(
        'session_running',
        'Wait for the active session or file reconciliation to finish.',
        409,
      );
  }
  async function bump(client, id) {
    await client.query(
      'UPDATE archive_batches SET updated_at=now(),version=version+1 WHERE id=$1',
      [id],
    );
  }
  const api = {
    async get(user, id) {
      uuid(id);
      return transaction(pool, async (client) => {
        // Keep the batch version consistent with session/page state during reconciliation.
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const batch = (await client.query(`${summary} WHERE b.id=$1`, [id])).rows[0];
        ownership(user, batch);
        const sessions = (
          await client.query(
            'SELECT * FROM scan_sessions WHERE batch_id=$1 ORDER BY session_number',
            [id],
          )
        ).rows;
        const pages = (
          await client.query(
            'SELECT * FROM pages WHERE batch_id=$1 ORDER BY display_order,capture_order',
            [id],
          )
        ).rows;
        return { batch, sessions, pages };
      });
    },
    async list(user, { search = '', status = '', limit = 25, offset = 0 } = {}) {
      const all = user.permissions.includes('batches:read_all');
      const where = `WHERE b.deleted_at IS NULL AND ($1::boolean OR b.assigned_operator_id=$2) AND ($3='' OR b.status=$3)
        AND ($4='' OR strpos(lower(b.batch_code),lower($4))>0 OR strpos(lower(coalesce(b.physical_location,'')),lower($4))>0)`;
      const args = [all, user.id, status, search];
      const rows = (
        await pool.query(`${summary} ${where} ORDER BY b.updated_at DESC,b.id LIMIT $5 OFFSET $6`, [
          ...args,
          limit,
          offset,
        ])
      ).rows;
      const total = (await pool.query(`SELECT count(*)::int FROM archive_batches b ${where}`, args))
        .rows[0].count;
      const activity = (
        await pool.query(
          'SELECT action,batch_id,created_at FROM audit_logs WHERE actor_id=$1 AND batch_id IS NOT NULL ORDER BY created_at DESC LIMIT 8',
          [user.id],
        )
      ).rows;
      return { batches: rows, total, activity };
    },
    async create(user, body) {
      keys(body, ['physicalLocation']);
      const id = randomUUID();
      await transaction(pool, async (client) => {
        await client.query(
          'INSERT INTO archive_batches(id,batch_code,created_by,assigned_operator_id,physical_location) VALUES($1,$2,$3,$3,$4)',
          [
            id,
            batchCode(),
            user.id,
            body.physicalLocation === undefined
              ? null
              : text(body.physicalLocation, 240, 'Physical location', true),
          ],
        );
        await client.query('INSERT INTO documents(batch_id,document_index) VALUES($1,1)', [id]);
        await audit(client, user, 'batch.created', 'batch', id, {}, id);
      });
      return api.get(user, id);
    },
    async location(user, id, body) {
      uuid(id);
      keys(body, ['version', 'physicalLocation']);
      const location = text(body.physicalLocation, 240, 'Physical location', true);
      await transaction(pool, async (client) => {
        const batch = (
          await client.query('SELECT * FROM archive_batches WHERE id=$1 FOR UPDATE', [id])
        ).rows[0];
        ownership(user, batch, true);
        mutable(batch);
        version(batch, body.version);
        await noRunning(client, id);
        await client.query('UPDATE archive_batches SET physical_location=$2 WHERE id=$1', [
          id,
          location,
        ]);
        await bump(client, id);
        await audit(
          client,
          user,
          'batch.location_updated',
          'batch',
          id,
          { physicalLocation: location },
          id,
        );
      });
      return api.get(user, id);
    },
    async transition(user, id, operation, body) {
      uuid(id);
      keys(body, ['version', 'acknowledgePartial']);
      if (body.acknowledgePartial !== undefined && typeof body.acknowledgePartial !== 'boolean')
        throw failure('invalid_request', 'acknowledgePartial must be boolean.');
      await transaction(pool, async (client) => {
        const batch = (
          await client.query('SELECT * FROM archive_batches WHERE id=$1 FOR UPDATE', [id])
        ).rows[0];
        ownership(user, batch, true);
        if (operation === 'complete-capture' && batch.status === 'capture_completed') {
          const existing = await client.query('SELECT id FROM ocr_jobs WHERE batch_id=$1 LIMIT 1', [
            id,
          ]);
          if (!existing.rowCount)
            await client.query('SELECT queue_batch_ocr($1,$2,$3)', [id, ocrLanguage, ocrConfig]);
          return;
        }
        mutable(batch);
        version(batch, body.version);
        await noRunning(client, id);
        const states = {
          resume: 'in_progress',
          pause: 'paused',
          'complete-capture': 'capture_completed',
          cancel: 'cancelled',
        };
        if (!(operation in states)) throw failure('not_found', 'Batch operation not found.', 404);
        const pages = (
          await client.query('SELECT * FROM pages WHERE batch_id=$1 ORDER BY capture_order', [id])
        ).rows;
        if (operation === 'cancel' && pages.length)
          throw failure(
            'has_pages',
            'Only empty batches can be cancelled; captured pages cannot be deleted.',
            409,
          );
        if (operation === 'complete-capture') {
          if (!pages.some((page) => !page.is_excluded))
            throw failure(
              'empty_batch',
              'Keep at least one valid page before completing capture.',
              409,
            );
          const partial = (
            await client.query(
              "SELECT 1 FROM scan_sessions WHERE batch_id=$1 AND status IN ('partial','interrupted')",
              [id],
            )
          ).rowCount;
          if (partial && body.acknowledgePartial !== true)
            throw failure(
              'partial_acknowledgement',
              'Explicitly acknowledge partial or interrupted sessions before completing capture.',
              409,
            );
          for (const page of pages) await storage.validate(page);
        }
        await client.query(
          `UPDATE archive_batches SET status=$2,paused_at=CASE WHEN $2='paused' THEN now() ELSE paused_at END,
          capture_completed_at=CASE WHEN $2='capture_completed' THEN now() ELSE capture_completed_at END WHERE id=$1`,
          [id, states[operation]],
        );
        await bump(client, id);
        if (operation === 'complete-capture')
          await client.query('SELECT queue_batch_ocr($1,$2,$3)', [id, ocrLanguage, ocrConfig]);
        await audit(
          client,
          user,
          {
            resume: 'batch.resumed',
            pause: 'batch.paused',
            'complete-capture': 'batch.capture_completed',
            cancel: 'batch.cancelled',
          }[operation],
          'batch',
          id,
          {
            pages: pages.filter((page) => !page.is_excluded).length,
            acknowledgedPartial: body.acknowledgePartial === true,
          },
          id,
        );
      });
      return api.get(user, id);
    },
    async remove(user, id, body) {
      uuid(id);
      keys(body, ['version']);
      await transaction(pool, async (client) => {
        const batch = (
          await client.query('SELECT * FROM archive_batches WHERE id=$1 FOR UPDATE', [id])
        ).rows[0];
        ownership(user, batch, true);
        mutable(batch);
        version(batch, body.version);
        await noRunning(client, id);
        await client.query(
          'UPDATE archive_batches SET deleted_at=now(),deleted_by=$2,updated_at=now(),version=version+1 WHERE id=$1',
          [id, user.id],
        );
        await audit(
          client,
          user,
          'batch.deleted',
          'batch',
          id,
          { previousStatus: batch.status, originalsRetained: true },
          id,
        );
      });
      return { deleted: true, batchId: id };
    },
    async reassign(user, id, body) {
      uuid(id);
      keys(body, ['version', 'operatorId']);
      uuid(body.operatorId);
      await transaction(pool, async (client) => {
        const batch = (
          await client.query('SELECT * FROM archive_batches WHERE id=$1 FOR UPDATE', [id])
        ).rows[0];
        if (!batch) throw failure('not_found', 'Batch not found.', 404);
        mutable(batch);
        version(batch, body.version);
        await noRunning(client, id);
        const operator = (
          await client.query(
            "SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE u.id=$1 AND u.is_active AND r.code='operator'",
            [body.operatorId],
          )
        ).rows[0];
        if (!operator)
          throw failure('invalid_operator', 'Assign an active user with the Operator role.');
        await client.query('UPDATE archive_batches SET assigned_operator_id=$2 WHERE id=$1', [
          id,
          body.operatorId,
        ]);
        await bump(client, id);
        await audit(
          client,
          user,
          'batch.reassigned',
          'batch',
          id,
          { from: batch.assigned_operator_id, to: body.operatorId },
          id,
        );
      });
      return api.get(user, id);
    },
    async start(user, id, body) {
      uuid(id);
      keys(body, ['version', 'options']);
      if (
        body.options !== undefined &&
        (!body.options || typeof body.options !== 'object' || Array.isArray(body.options))
      )
        throw failure('invalid_request', 'Invalid scanner options.');
      requirePermission(user, 'scanner:scan');
      const sessionId = randomUUID();
      await scanner.start(
        body.options || {},
        async (job) => {
          await transaction(pool, async (client) => {
            const batch = (
              await client.query('SELECT * FROM archive_batches WHERE id=$1 FOR UPDATE', [id])
            ).rows[0];
            ownership(user, batch, true);
            mutable(batch);
            version(batch, body.version);
            if (batch.status !== 'in_progress')
              throw failure('batch_paused', 'Resume this batch before scanning.', 409);
            await noRunning(client, id);
            const document = (
              await client.query(
                'SELECT id FROM documents WHERE batch_id=$1 ORDER BY document_index LIMIT 1',
                [id],
              )
            ).rows[0];
            const next = (
              await client.query(
                'SELECT coalesce(max(session_number),0)+1 AS number FROM scan_sessions WHERE batch_id=$1',
                [id],
              )
            ).rows[0].number;
            const base = (
              await client.query(
                'SELECT greatest(coalesce((SELECT max(capture_order) FROM pages WHERE batch_id=$1),0),coalesce((SELECT max(capture_order_base+captured_file_count) FROM scan_sessions WHERE batch_id=$1),0)) AS n',
                [id],
              )
            ).rows[0].n;
            const selected = scanner.status();
            const profile = selected.profiles?.find((p) => p.id === selected.profileId);
            await client.query(
              `INSERT INTO scan_sessions(id,batch_id,document_id,session_number,status,created_by,scanner_mode,device_id,device_name,profile_id,profile_name,settings_snapshot,job_id,capture_order_base)
            VALUES($1,$2,$3,$4,'running',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
              [
                sessionId,
                id,
                document.id,
                next,
                user.id,
                job.provider,
                job.deviceId,
                selected.device?.name,
                job.profileId,
                profile?.name,
                { ...job.options, profileSettings: profile?.settings || null },
                job.id,
                base,
              ],
            );
            await bump(client, id);
            await audit(
              client,
              user,
              'scan_session.started',
              'scan_session',
              sessionId,
              { sessionNumber: next, mode: job.provider },
              id,
            );
          });
        },
        sessionId,
      );
      return api.get(user, id);
    },
    reconcile(session, interrupted = false) {
      if (working.has(session.id)) return working.get(session.id);
      const work = (async () => {
        const batch = (
          await pool.query('SELECT status,deleted_at FROM archive_batches WHERE id=$1', [
            session.batch_id,
          ])
        ).rows[0];
        if (!batch || batch.deleted_at || !['in_progress', 'paused'].includes(batch.status)) return;
        let job;
        try {
          job = await scanner.job(session.job_id);
        } catch (error) {
          if (error.code !== 'not_found') throw error;
        }
        const sourceRoot = scanner.providers[session.scanner_mode]?.scans;
        const candidates =
          job?.pages || (await listPages(sourceRoot, session.scanner_mode, session.job_id));
        const registered = new Set(
          (
            await pool.query('SELECT original_storage_key FROM pages WHERE scan_session_id=$1', [
              session.id,
            ])
          ).rows.map((row) => row.original_storage_key),
        );
        const finalized = [];
        const issues = [];
        for (const candidate of candidates) {
          const key = `batches/${session.batch_id}/sessions/${session.id}/page-${String(candidate.pageNumber).padStart(4, '0')}.png`;
          if (registered.has(key)) continue;
          try {
            finalized.push({
              ...(await storage.finalize(
                session,
                candidate.pageNumber,
                sourceRoot,
                candidate.filename,
              )),
              number: candidate.pageNumber,
            });
          } catch (error) {
            issues.push(
              error.statusCode
                ? error.message
                : 'A captured file could not be finalized. Check storage; source files are retained.',
            );
          }
        }
        const ended = interrupted || !job || job.status !== 'scanning';
        await transaction(pool, async (client) => {
          const lockedBatch = (
            await client.query('SELECT id,deleted_at FROM archive_batches WHERE id=$1 FOR UPDATE', [
              session.batch_id,
            ])
          ).rows[0];
          if (!lockedBatch || lockedBatch.deleted_at) return;
          const current = (
            await client.query('SELECT * FROM scan_sessions WHERE id=$1 FOR UPDATE', [session.id])
          ).rows[0];
          let added = 0;
          for (const file of finalized) {
            const exists = (
              await client.query('SELECT 1 FROM pages WHERE original_storage_key=$1', [file.key])
            ).rowCount;
            if (exists) continue;
            const order = current.capture_order_base + file.number;
            added++;
            await client.query(
              `INSERT INTO pages(batch_id,document_id,scan_session_id,capture_order,display_order,original_storage_key,active_storage_key,mime_type,byte_size,sha256,width_px,height_px,dpi,source)
              VALUES($1,$2,$3,$4,$4,$5,$5,'image/png',$6,$7,$8,$9,$10,$11)`,
              [
                session.batch_id,
                session.document_id,
                session.id,
                order,
                file.key,
                file.byteSize,
                file.sha256,
                file.width,
                file.height,
                file.dpi,
                session.scanner_mode,
              ],
            );
          }
          const count = (
            await client.query(
              'SELECT count(*)::int AS count FROM pages WHERE scan_session_id=$1',
              [session.id],
            )
          ).rows[0].count;
          const error =
            [job?.error, ...issues].filter(Boolean).join(' ').slice(0, 2000) ||
            (interrupted || !job
              ? 'Application restarted during capture. Check hardware before retrying.'
              : ended && !count
                ? 'The scanner returned no valid pages. Check the feeder and retained capture spool.'
                : null);
          const status = !ended
            ? 'running'
            : interrupted || !job
              ? 'interrupted'
              : error
                ? count
                  ? 'partial'
                  : 'failed'
                : count
                  ? 'completed'
                  : 'failed';
          await client.query(
            `UPDATE scan_sessions SET page_count=$2,status=$3,error_summary=$4,completed_at=CASE WHEN $5 THEN coalesce(completed_at,now()) ELSE completed_at END,
            recovery_pending=false,device_id=coalesce($6,device_id),profile_id=coalesce($7,profile_id),captured_file_count=greatest(captured_file_count,$8) WHERE id=$1`,
            [
              session.id,
              count,
              status,
              error,
              ended,
              job?.deviceId,
              job?.profileId,
              Math.max(0, ...candidates.map((page) => page.pageNumber)),
            ],
          );
          if (added || current.status !== status || current.recovery_pending)
            await bump(client, session.batch_id);
          if (ended && (current.status === 'running' || current.recovery_pending))
            await audit(
              client,
              { id: session.created_by },
              `scan_session.${status}`,
              'scan_session',
              session.id,
              { pages: count, error },
              session.batch_id,
            );
        });
        if (ended) scanner.releaseJob(session.job_id);
      })();
      working.set(session.id, work);
      work.finally(() => working.delete(session.id)).catch(() => {});
      return work;
    },
    async recover() {
      const sessions = (
        await pool.query(
          "SELECT * FROM scan_sessions WHERE status='running' OR recovery_pending ORDER BY started_at",
        )
      ).rows;
      for (const session of sessions) await api.reconcile(session);
    },
    async sweep() {
      const sessions = (
        await pool.query(
          "SELECT * FROM scan_sessions WHERE status='running' OR recovery_pending ORDER BY started_at",
        )
      ).rows;
      for (const session of sessions) await api.reconcile(session);
    },
    async editPage(user, id, body) {
      uuid(id);
      keys(body, ['version', 'action']);
      if (!['rotate-left', 'rotate-right', 'remove', 'restore'].includes(body.action))
        throw failure('invalid_request', 'Choose a valid page action.');
      let batchId;
      await transaction(pool, async (client) => {
        const record = (await client.query('SELECT batch_id FROM pages WHERE id=$1', [id])).rows[0];
        if (!record) throw failure('not_found', 'Page not found.', 404);
        batchId = record.batch_id;
        const batch = (
          await client.query('SELECT * FROM archive_batches WHERE id=$1 FOR UPDATE', [batchId])
        ).rows[0];
        ownership(user, batch, true);
        mutable(batch);
        version(batch, body.version);
        await noRunning(client, batchId);
        const page = (await client.query('SELECT * FROM pages WHERE id=$1 FOR UPDATE', [id]))
          .rows[0];
        const rotating = body.action.startsWith('rotate-');
        if (rotating && page.is_excluded)
          throw failure('page_removed', 'Restore this page before rotating it.', 409);
        const rotation = rotating
          ? (page.rotation_degrees + (body.action === 'rotate-right' ? 90 : 270)) % 360
          : page.rotation_degrees;
        const excluded = rotating ? page.is_excluded : body.action === 'remove';
        if (rotation === page.rotation_degrees && excluded === page.is_excluded) return;
        await client.query(
          'UPDATE pages SET rotation_degrees=$2,is_excluded=$3,updated_at=now() WHERE id=$1',
          [id, rotation, excluded],
        );
        await bump(client, batchId);
        await audit(
          client,
          user,
          rotating ? 'page.rotated' : excluded ? 'page.removed' : 'page.restored',
          'page',
          id,
          { previousRotation: page.rotation_degrees, rotation, excluded },
          batchId,
        );
      });
      return api.get(user, batchId);
    },
    async page(user, id) {
      uuid(id);
      const page = (
        await pool.query(
          'SELECT p.*,b.assigned_operator_id,b.deleted_at FROM pages p JOIN archive_batches b ON b.id=p.batch_id WHERE p.id=$1',
          [id],
        )
      ).rows[0];
      ownership(user, page);
      return page;
    },
  };
  return api;
}
