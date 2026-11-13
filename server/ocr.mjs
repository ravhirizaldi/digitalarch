import { randomUUID } from 'node:crypto';
import { transaction } from './db.mjs';
import { audit, digest, keys, requirePermission, uuid } from './auth.mjs';
import { failure } from './errors.mjs';
import { ocrSettings } from './ocr-provider.mjs';
import { ocrProvider } from './ocr-engines.mjs';
import { ocrDefaults } from './ocr-defaults.mjs';
import { processingConfig } from './ocr-profiles.mjs';

const jobSelect = `SELECT j.*,b.batch_code,b.assigned_operator_id,
  (SELECT count(*)::int FROM scan_sessions s WHERE s.batch_id=j.batch_id) AS session_count,
  (SELECT p.capture_order FROM page_ocr_results r JOIN pages p ON p.id=r.page_id WHERE r.ocr_job_id=j.id AND r.status='processing' LIMIT 1) AS current_page
  FROM ocr_jobs j JOIN archive_batches b ON b.id=j.batch_id`;
const publicJob = (job) =>
  Object.fromEntries(
    Object.entries(job).filter(
      ([key]) => !['lease_token', 'lease_expires_at', 'manifest_hash'].includes(key),
    ),
  );
const publicPage = (page) =>
  Object.fromEntries(
    Object.entries(page).filter(([key]) => !['storage_key', 'reused_result_id'].includes(key)),
  );
const terminal = ['completed', 'completed_with_errors', 'failed', 'cancelled'];

export function ocrProcessing(pool, storage, options = {}) {
  const settings = { ...ocrSettings(), ...options.settings };
  const provider = options.provider || ocrProvider(settings);
  const defaults = ocrDefaults(pool, settings, provider);
  const controllers = new Set();
  const tasks = new Set();
  const allowed = options.allowed || (() => true);
  let timer;
  let closed = false;
  let ticking = false;

  async function authorize(user, id, manage = false, client = pool, lock = false) {
    uuid(id);
    requirePermission(user, manage ? 'ocr:manage' : 'ocr:read');
    const job = (
      await client.query(
        `${jobSelect} WHERE j.id=$1 AND b.deleted_at IS NULL ${lock ? 'FOR UPDATE OF j' : ''}`,
        [id],
      )
    ).rows[0];
    if (!job) throw failure('not_found', 'OCR job not found.', 404);
    if (
      job.assigned_operator_id !== user.id &&
      !user.permissions.includes(manage ? 'ocr:manage_all' : 'ocr:read_all')
    )
      throw failure('forbidden', 'This OCR job belongs to another operator.', 403);
    return job;
  }
  async function syncBatch(client, job) {
    await client.query(
      `UPDATE archive_batches SET ocr_status=$2 WHERE id=$1 AND NOT EXISTS
      (SELECT 1 FROM ocr_jobs newer JOIN ocr_jobs current ON current.id=$3
       WHERE newer.batch_id=$1 AND (newer.created_at,newer.id)>(current.created_at,current.id))`,
      [job.batch_id, job.status, job.id],
    );
  }
  async function summarize(client, id) {
    const counts = (
      await client.query(
        `SELECT count(*) FILTER(WHERE status='completed')::int AS processed,
      count(*) FILTER(WHERE status='failed')::int AS failed,
      count(*) FILTER(WHERE status IN ('queued','processing'))::int AS pending FROM page_ocr_results WHERE ocr_job_id=$1`,
        [id],
      )
    ).rows[0];
    const job = (
      await client.query(
        `UPDATE ocr_jobs SET processed_pages=$2,failed_pages=$3,
      status=CASE WHEN status IN ('cancelled','failed') THEN status WHEN $4=0 THEN CASE WHEN $3>0 THEN 'completed_with_errors' ELSE 'completed' END ELSE status END,
      completed_at=CASE WHEN $4=0 AND status NOT IN ('cancelled','failed') THEN now() ELSE completed_at END,
      last_error=CASE WHEN $4=0 AND $3=0 AND status NOT IN ('cancelled','failed') THEN NULL ELSE last_error END,
      updated_at=now(),version=version+1 WHERE id=$1 RETURNING *`,
        [id, counts.processed, counts.failed, counts.pending],
      )
    ).rows[0];
    await syncBatch(client, job);
    return job;
  }
  async function recover() {
    return transaction(pool, async (client) => {
      const jobs = (
        await client.query(
          `SELECT * FROM ocr_jobs WHERE lease_token IS NOT NULL AND lease_expires_at<now() FOR UPDATE SKIP LOCKED`,
        )
      ).rows;
      for (const job of jobs) {
        await client.query(
          `UPDATE page_ocr_results SET status=CASE WHEN attempt_count>=$2 THEN 'failed' ELSE 'queued' END,
          error_code='worker_interrupted',error_message='OCR worker was interrupted; persisted results were retained.',
          processed_at=CASE WHEN attempt_count>=$2 THEN now() ELSE NULL END,updated_at=now()
          WHERE ocr_job_id=$1 AND status='processing'`,
          [job.id, settings.maxAttempts],
        );
        await client.query(
          `UPDATE ocr_jobs SET lease_token=NULL,lease_expires_at=NULL,
          status=CASE WHEN status='running' THEN 'queued' ELSE status END,last_error='An interrupted OCR claim was recovered.',updated_at=now() WHERE id=$1`,
          [job.id],
        );
        await summarize(client, job.id);
        await audit(client, null, 'ocr.recovered', 'ocr_job', job.id, {}, job.batch_id);
      }
      return jobs.length;
    });
  }
  async function claim() {
    if (closed || !allowed()) return null;
    return transaction(pool, async (client) => {
      const job = (
        await client.query(`SELECT j.* FROM ocr_jobs j JOIN archive_batches b ON b.id=j.batch_id
        WHERE j.status='queued' AND j.lease_token IS NULL AND b.status='capture_completed' AND b.deleted_at IS NULL
        AND EXISTS(SELECT 1 FROM page_ocr_results r WHERE r.ocr_job_id=j.id AND r.status='queued' AND r.next_attempt_at<=now())
        ORDER BY j.created_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`)
      ).rows[0];
      if (!job) return null;
      const token = randomUUID();
      const claimed = (
        await client.query(
          `UPDATE ocr_jobs SET status='running',lease_token=$2,
        lease_expires_at=now()+$3*interval '1 second',worker_started_at=now(),started_at=coalesce(started_at,now()),
        attempt_count=attempt_count+1,updated_at=now(),version=version+1 WHERE id=$1 RETURNING *`,
          [job.id, token, settings.leaseSeconds],
        )
      ).rows[0];
      await syncBatch(client, claimed);
      return claimed;
    });
  }
  async function release(job, error = null) {
    return transaction(pool, async (client) => {
      const locked = (
        await client.query(
          'SELECT * FROM ocr_jobs WHERE id=$1 AND lease_token=$2 AND lease_expires_at>now() FOR UPDATE',
          [job.id, job.lease_token],
        )
      ).rows[0];
      if (!locked) return;
      await client.query(
        `UPDATE ocr_jobs SET lease_token=NULL,lease_expires_at=NULL,
        status=CASE WHEN $3::text IS NOT NULL THEN 'failed' WHEN status='running' THEN 'queued' ELSE status END,
        last_error=coalesce($3,last_error),completed_at=CASE WHEN $3::text IS NOT NULL THEN now() ELSE completed_at END,
        updated_at=now(),version=version+1 WHERE id=$1 AND lease_token=$2`,
        [job.id, job.lease_token, error],
      );
      const updated = await summarize(client, job.id);
      if (error || terminal.includes(updated.status))
        await audit(client, null, `ocr.${updated.status}`, 'ocr_job', job.id, {}, job.batch_id);
    });
  }
  async function work(job) {
    const controller = new AbortController();
    controllers.add(controller);
    const heartbeat = setInterval(
      async () => {
        try {
          if (!allowed()) return controller.abort();
          const result = await pool.query(
            `UPDATE ocr_jobs SET lease_expires_at=now()+$3*interval '1 second'
          WHERE id=$1 AND lease_token=$2 AND lease_expires_at>now()`,
            [job.id, job.lease_token, settings.leaseSeconds],
          );
          if (!result.rowCount) controller.abort();
        } catch {
          controller.abort();
        }
      },
      Math.min(10000, Math.max(100, Math.floor((settings.leaseSeconds * 1000) / 3))),
    );
    heartbeat.unref();
    let page;
    try {
      const info = await provider.info(job.language, controller.signal, job.processing_config);
      if (info.engine !== job.engine)
        throw failure('ocr_protocol', 'OCR engine differs from the queued engine.', 503);
      const identity = digest(
        JSON.stringify({
          engine: info.engine,
          version: info.engineVersion,
          language: job.language,
          configuration: info.configuration,
        }),
      );
      if (job.config_hash && job.config_hash !== identity)
        throw failure(
          'ocr_configuration_changed',
          'OCR engine or language files changed. Restore the recorded configuration before retrying this job.',
          409,
        );
      page = await transaction(pool, async (client) => {
        const locked = (
          await client.query(
            'SELECT * FROM ocr_jobs WHERE id=$1 AND lease_token=$2 AND lease_expires_at>now() FOR UPDATE',
            [job.id, job.lease_token],
          )
        ).rows[0];
        if (!locked || locked.status !== 'running' || controller.signal.aborted) return null;
        await client.query(
          'UPDATE ocr_jobs SET engine_version=$2,engine_config=$3,config_hash=$4 WHERE id=$1',
          [job.id, info.engineVersion, info.configuration, identity],
        );
        const candidate = (
          await client.query(
            `SELECT * FROM page_ocr_results WHERE ocr_job_id=$1 AND status='queued' AND next_attempt_at<=now()
          ORDER BY (SELECT capture_order FROM pages WHERE id=page_id) FOR UPDATE LIMIT 1`,
            [job.id],
          )
        ).rows[0];
        if (!candidate) return null;
        const pageConfig = digest(`${identity}:${candidate.rotation_degrees}`);
        return (
          await client.query(
            `UPDATE page_ocr_results SET status='processing',attempt_count=attempt_count+1,
          engine_version=$2,config_hash=$3,updated_at=now() WHERE id=$1 RETURNING *`,
            [candidate.id, info.engineVersion, pageConfig],
          )
        ).rows[0];
      });
      if (!page) return await release(job);
      let output;
      let pageError;
      let cached;
      try {
        if (page.is_stale)
          throw failure(
            'stale_image',
            'This page revision is stale; OCR is scheduled for the current revision.',
            409,
          );
        const buffer = await storage.ocrImage(page);
        cached = (
          await pool.query(
            `SELECT id FROM page_ocr_results WHERE page_id=$1 AND image_sha256=$2 AND config_hash=$3
          AND status='completed' AND reused_result_id IS NULL LIMIT 1`,
            [page.page_id, page.image_sha256, page.config_hash],
          )
        ).rows[0];
        if (!cached) {
          output = await provider.process(
            buffer,
            page,
            job.language,
            controller.signal,
            job.processing_config,
          );
          const actual = digest(
            JSON.stringify({
              engine: output.engine,
              version: output.engineVersion,
              language: job.language,
              configuration: output.configuration,
            }),
          );
          if (
            actual !== identity ||
            typeof output.text !== 'string' ||
            output.text.length > 2_000_000 ||
            !Number.isSafeInteger(output.processingMs) ||
            output.processingMs < 0
          )
            throw failure(
              'ocr_protocol',
              'OCR result does not match the claimed engine configuration.',
              503,
            );
        }
        // Detect external modification during OCR, including when reusing an exact result.
        await storage.ocrImage(page);
      } catch (error) {
        pageError = error;
      }
      await transaction(pool, async (client) => {
        const locked = (
          await client.query(
            'SELECT * FROM ocr_jobs WHERE id=$1 AND lease_token=$2 AND lease_expires_at>now() FOR UPDATE',
            [job.id, job.lease_token],
          )
        ).rows[0];
        if (!locked) return;
        const latest = (
          await client.query('SELECT is_stale FROM page_ocr_results WHERE id=$1 FOR UPDATE', [
            page.id,
          ])
        ).rows[0];
        if (controller.signal.aborted) {
          await client.query(
            "UPDATE page_ocr_results SET status='queued',attempt_count=greatest(0,attempt_count-1),updated_at=now() WHERE id=$1",
            [page.id],
          );
        } else if (pageError || latest.is_stale) {
          const code = latest.is_stale ? 'stale_image' : pageError.code || 'ocr_failed';
          const permanent =
            [
              'image_changed',
              'invalid_image',
              'invalid_storage_key',
              'ENOENT',
              'EACCES',
              'stale_image',
            ].includes(code) || page.attempt_count >= settings.maxAttempts;
          const message =
            {
              image_changed:
                'Source checksum mismatch. Restore the recorded PNG; text was not reused.',
              stale_image: 'A newer page revision has replaced this image.',
              invalid_image: 'Managed PNG is empty, unsupported or corrupt.',
              ENOENT: 'Managed PNG is missing.',
              EACCES: 'Managed PNG is not readable.',
            }[code] ||
            'OCR page processing failed. Check the selected engine runtime, image and model/language resources.';
          await client.query(
            `UPDATE page_ocr_results SET status=$2,error_code=$3,error_message=$4,
            processed_at=CASE WHEN $2='failed' THEN now() ELSE NULL END,
            next_attempt_at=now()+$5*interval '1 millisecond',updated_at=now() WHERE id=$1`,
            [
              page.id,
              permanent ? 'failed' : 'queued',
              code,
              message,
              settings.retryDelayMs * 2 ** (page.attempt_count - 1),
            ],
          );
          await client.query('UPDATE ocr_jobs SET last_error=$2 WHERE id=$1', [job.id, message]);
        } else {
          await client.query(
            `UPDATE page_ocr_results SET status='completed',extracted_text=$2,structured_result=$3,
            reused_result_id=$4,processed_at=now(),processing_ms=$5,error_code=NULL,error_message=NULL,updated_at=now() WHERE id=$1`,
            [
              page.id,
              output?.text ?? null,
              output?.structuredResult ?? null,
              cached?.id || null,
              output?.processingMs ?? 0,
            ],
          );
        }
        await summarize(client, job.id);
      });
      await release(job);
    } catch (error) {
      if (controller.signal.aborted) {
        if (page)
          await pool
            .query(
              "UPDATE page_ocr_results SET status='queued',attempt_count=greatest(0,attempt_count-1) WHERE id=$1 AND status='processing' AND EXISTS(SELECT 1 FROM ocr_jobs WHERE id=$2 AND lease_token=$3)",
              [page.id, job.id, job.lease_token],
            )
            .catch(() => {});
        await release(job).catch(() => {});
      } else {
        const message = [
          'ocr_language_missing',
          'ocr_unavailable',
          'ocr_configuration_changed',
        ].includes(error.code)
          ? error.message
          : 'OCR job could not initialize or persist results. Check PostgreSQL and the selected OCR runtime/resources.';
        await release(job, message).catch(() => {});
      }
    } finally {
      clearInterval(heartbeat);
      controllers.delete(controller);
    }
  }
  async function runOne() {
    const job = await claim();
    if (!job) return false;
    await work(job);
    return true;
  }
  async function tick() {
    if (closed || ticking || !allowed()) return;
    ticking = true;
    try {
      await recover();
      while (!closed && allowed() && tasks.size < settings.concurrency) {
        const job = await claim();
        if (!job) break;
        const task = work(job);
        tasks.add(task);
        task.finally(() => tasks.delete(task)).catch(() => {});
      }
    } finally {
      ticking = false;
    }
  }
  return {
    settings,
    initializeDefaults: defaults.current,
    getSettings: defaults.get,
    updateSettings: defaults.update,
    async currentDefaults(user) {
      requirePermission(user, 'ocr:read');
      return { defaults: await defaults.current() };
    },
    async engines(user) {
      requirePermission(user, 'ocr:read');
      const catalog = provider.catalog ? await provider.catalog() : { engines: [] };
      return {
        ...catalog,
        defaultEngine: (await defaults.current()).processing_config.engine || 'tesseract',
      };
    },
    claim,
    recover,
    runOne,
    tick,
    start() {
      if (timer || closed || options.enabled === false) return;
      timer = setInterval(() => tick().catch(() => {}), 500);
      timer.unref();
    },
    interrupt() {
      for (const controller of controllers) controller.abort();
    },
    async close() {
      closed = true;
      clearInterval(timer);
      for (const controller of controllers) controller.abort();
      while (ticking) await new Promise((resolve) => setTimeout(resolve, 10));
      await Promise.allSettled([...tasks]);
    },
    async list(user, { limit, offset, status = '' }) {
      requirePermission(user, 'ocr:read');
      if (status && !['queued', 'running', 'paused', ...terminal].includes(status))
        throw failure('invalid_status', 'Invalid OCR status.');
      const all = user.permissions.includes('ocr:read_all');
      const where = 'WHERE b.deleted_at IS NULL AND ($1::boolean OR b.assigned_operator_id=$2)';
      const args = [all, user.id];
      const overview = (
        await pool.query(
          `SELECT count(*)::int AS total,
        count(*) FILTER(WHERE j.status='queued')::int AS queued,count(*) FILTER(WHERE j.status='running')::int AS running,
        count(*) FILTER(WHERE j.status='completed')::int AS completed,
        count(*) FILTER(WHERE j.status='failed' OR j.failed_pages>0)::int AS errors
        FROM ocr_jobs j JOIN archive_batches b ON b.id=j.batch_id ${where}`,
          args,
        )
      ).rows[0];
      const jobs = (
        await pool.query(
          `${jobSelect} ${where} AND ($3='' OR j.status=$3) ORDER BY j.created_at DESC,j.id LIMIT $4 OFFSET $5`,
          [...args, status, limit, offset],
        )
      ).rows.map(publicJob);
      const total = (
        await pool.query(
          `SELECT count(*)::int AS total FROM ocr_jobs j JOIN archive_batches b ON b.id=j.batch_id ${where} AND ($3='' OR j.status=$3)`,
          [...args, status],
        )
      ).rows[0].total;
      return { jobs, total, overview };
    },
    async enqueue(user, batchId, body) {
      uuid(batchId);
      keys(body, ['profile', 'psm', 'preprocessing', 'layout', 'engine', 'model', 'cpuThreads']);
      const config = Object.keys(body).length ? processingConfig(body) : null;
      requirePermission(user, 'ocr:manage');
      const id = await transaction(pool, async (client) => {
        const batch = (
          await client.query('SELECT * FROM archive_batches WHERE id=$1 FOR UPDATE', [batchId])
        ).rows[0];
        if (!batch || batch.deleted_at) throw failure('not_found', 'Batch not found.', 404);
        if (batch.assigned_operator_id !== user.id && !user.permissions.includes('ocr:manage_all'))
          throw failure('forbidden', 'This batch belongs to another operator.', 403);
        if (batch.status !== 'capture_completed')
          throw failure('batch_locked', 'Complete capture before sending the batch to OCR.', 409);
        const queued = (
          await client.query('SELECT queue_batch_ocr($1,$2,$3) AS id', [batchId, null, config])
        ).rows[0].id;
        if (!queued)
          throw failure('empty_batch', 'OCR requires at least one retained captured page.', 409);
        await audit(client, user, 'ocr.requested', 'ocr_job', queued, {}, batchId);
        return queued;
      });
      return this.get(user, id);
    },
    async get(user, id) {
      return { job: publicJob(await authorize(user, id)), defaults: await defaults.current() };
    },
    async image(user, id, pageId, size) {
      await authorize(user, id);
      uuid(pageId);
      const record = (
        await pool.query('SELECT * FROM page_ocr_results WHERE ocr_job_id=$1 AND page_id=$2', [
          id,
          pageId,
        ])
      ).rows[0];
      if (!record) throw failure('not_found', 'OCR source page not found.', 404);
      await storage.ocrImage(record);
      const file =
        size === 'image'
          ? await storage.open(record.storage_key)
          : await storage.derivative({ active_storage_key: record.storage_key }, 'preview');
      return { file, mime: size === 'image' ? 'image/png' : 'image/webp' };
    },
    async reprocess(user, id, body) {
      keys(body, [
        'version',
        'profile',
        'psm',
        'preprocessing',
        'layout',
        'engine',
        'model',
        'cpuThreads',
      ]);
      const explicit = Object.keys(body).some((key) => key !== 'version');
      const override = explicit
        ? processingConfig({
            profile: body.profile ?? 'standard',
            psm: body.psm,
            preprocessing: body.preprocessing,
            layout: body.layout,
            engine: body.engine,
            model: body.model,
            cpuThreads: body.cpuThreads,
          })
        : null;
      const next = await transaction(pool, async (client) => {
        const job = await authorize(user, id, true, client, true);
        if (job.version !== body.version)
          throw failure('conflict', 'OCR job changed. Refresh before continuing.', 409);
        if (!terminal.includes(job.status))
          throw failure('ocr_locked', 'Finish or cancel this run before reprocessing.', 409);
        const global = explicit ? null : await defaults.current(client);
        const config = override || global.processing_config;
        const target = (
          await client.query('SELECT queue_batch_ocr($1,$2,$3,$4) AS id', [
            job.batch_id,
            global?.language || job.language,
            config,
            id,
          ])
        ).rows[0].id;
        if (!target) throw failure('empty_batch', 'OCR requires retained captured pages.', 409);
        await audit(
          client,
          user,
          'ocr.reprocessed',
          'ocr_job',
          target,
          { previousJobId: id, profile: config.profile, psm: config.psm },
          job.batch_id,
        );
        return target;
      });
      return this.get(user, next);
    },
    async pages(user, id, { limit, offset }) {
      await authorize(user, id);
      const pages = (
        await pool.query(
          `SELECT r.*,p.capture_order AS page_number,s.session_number,p.width_px,p.height_px,
        coalesce(r.extracted_text,c.extracted_text) AS extracted_text,coalesce(r.structured_result,c.structured_result) AS structured_result
        FROM page_ocr_results r JOIN pages p ON p.id=r.page_id JOIN scan_sessions s ON s.id=p.scan_session_id
        LEFT JOIN page_ocr_results c ON c.id=r.reused_result_id WHERE r.ocr_job_id=$1 ORDER BY p.capture_order LIMIT $2 OFFSET $3`,
          [id, limit, offset],
        )
      ).rows.map(publicPage);
      return { pages };
    },
    async page(user, id) {
      uuid(id);
      requirePermission(user, 'ocr:read');
      const page = (
        await pool.query(
          'SELECT p.*,b.assigned_operator_id FROM pages p JOIN archive_batches b ON b.id=p.batch_id WHERE p.id=$1 AND b.deleted_at IS NULL',
          [id],
        )
      ).rows[0];
      if (!page) throw failure('not_found', 'Page not found.', 404);
      if (page.assigned_operator_id !== user.id && !user.permissions.includes('ocr:read_all'))
        throw failure('forbidden', 'This page belongs to another operator.', 403);
      await storage.ocrImage({
        storage_key: page.active_storage_key,
        image_sha256: page.active_image_sha256,
      });
      const result = (
        await pool.query(
          `SELECT r.*,coalesce(r.extracted_text,c.extracted_text) AS extracted_text,
        coalesce(r.structured_result,c.structured_result) AS structured_result FROM page_ocr_results r JOIN ocr_jobs j ON j.id=r.ocr_job_id
        LEFT JOIN page_ocr_results c ON c.id=r.reused_result_id
        WHERE r.page_id=$1 AND r.image_sha256=$2 AND r.rotation_degrees=$3 AND NOT r.is_stale ORDER BY j.created_at DESC,j.id DESC LIMIT 1`,
          [id, page.active_image_sha256, page.rotation_degrees],
        )
      ).rows[0];
      return { result: result ? publicPage(result) : null };
    },
    async control(user, id, action, body) {
      keys(body, ['version']);
      await transaction(pool, async (client) => {
        const job = await authorize(user, id, true, client, true);
        if (!Number.isSafeInteger(body.version) || body.version !== job.version)
          throw failure('conflict', 'OCR job changed. Refresh before continuing.', 409);
        const allowedStates = {
          pause: ['queued', 'running'],
          resume: ['paused'],
          cancel: ['queued'],
          'retry-failed': ['completed_with_errors', 'failed'],
        };
        if (
          !allowedStates[action]?.includes(job.status) ||
          (action === 'cancel' && job.lease_token)
        )
          throw failure(
            'ocr_locked',
            'This OCR action is not available in the current state.',
            409,
          );
        if (action === 'cancel')
          await client.query(
            "UPDATE page_ocr_results SET status='cancelled',updated_at=now() WHERE ocr_job_id=$1 AND status='queued'",
            [id],
          );
        if (action === 'retry-failed')
          await client.query(
            `UPDATE page_ocr_results SET status='queued',attempt_count=0,processed_at=NULL,error_code=NULL,error_message=NULL,next_attempt_at=now(),updated_at=now() WHERE ocr_job_id=$1 AND status IN ('failed','processing')`,
            [id],
          );
        const status = {
          pause: 'paused',
          resume: 'queued',
          cancel: 'cancelled',
          'retry-failed': 'queued',
        }[action];
        await client.query(
          `UPDATE ocr_jobs SET status=$2,last_error=NULL,completed_at=CASE WHEN $2='cancelled' THEN now() ELSE NULL END,updated_at=now(),version=version+1 WHERE id=$1`,
          [id, status],
        );
        await summarize(client, id);
        await audit(client, user, `ocr.${action}`, 'ocr_job', id, {}, job.batch_id);
      });
      return this.get(user, id);
    },
  };
}
