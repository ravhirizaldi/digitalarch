import QRCode from 'qrcode';
import { audit, keys, requirePermission, text, uuid } from './auth.mjs';
import { transaction } from './db.mjs';
import { failure } from './errors.mjs';
import {
  checkVersion,
  documentFor,
  independentReviewer,
  noCapture,
  publicPage,
  submittedBatch,
  qcOfficer,
} from './workflow.mjs';
import { currentOcr, metadataOf } from './qc-metadata.mjs';

export const finalPublication = `d.workflow_status='approved' AND r.outcome='passed' AND r.reviewed_revision=d.revision
  AND d.approval_l2_required IS NOT NULL AND d.approval_policy_version>0
  AND r.snapshot->'revision'=to_jsonb(d.revision)
  AND EXISTS(SELECT 1 FROM approval_decisions a WHERE a.qc_review_id=r.id AND a.level=1 AND a.decision='approved')
  AND (d.approval_l2_required=false OR EXISTS(SELECT 1 FROM approval_decisions a WHERE a.qc_review_id=r.id AND a.level=2 AND a.decision='approved'))`;

export function approvals(pool, storage) {
  function scope(user, position = 1) {
    const staff = user.permissions.some((p) =>
      ['qc:read', 'approval_l1:review', 'approval_l2:review'].includes(p),
    );
    return `(b.assigned_operator_id=$${position} OR ${user.permissions.includes('documents:read_all') ? 'true' : 'false'}
      OR (${staff ? 'true' : 'false'} AND ${submittedBatch}) OR (${finalPublication}))`;
  }
  async function load(client, user, batchId, lock = false) {
    requirePermission(user, 'documents:read');
    uuid(batchId);
    const batch = (
      await client.query(
        `SELECT b.* FROM archive_batches b
      JOIN LATERAL (SELECT * FROM documents WHERE batch_id=b.id ORDER BY document_index LIMIT 1) d ON true
      LEFT JOIN qc_reviews r ON r.document_id=d.id AND r.cycle=d.review_cycle
      WHERE b.id=$2 AND b.deleted_at IS NULL AND ${scope(user)} ${lock ? 'FOR UPDATE OF b' : ''}`,
        [user.id, batchId],
      )
    ).rows[0];
    if (!batch)
      throw failure('not_found', 'Document not found or not available to your role.', 404);
    const doc = await documentFor(client, batchId, lock);
    const review = (
      await client.query(
        `SELECT * FROM qc_reviews WHERE document_id=$1 AND cycle=$2 ${lock ? 'FOR UPDATE' : ''}`,
        [doc.id, doc.review_cycle],
      )
    ).rows[0];
    return { batch, doc, review };
  }
  async function candidate(client, batch, id, level, lock = false) {
    uuid(id);
    if (level === 'qc') return qcOfficer(client, batch, id, lock);
    const permission = `approval_l${level}:approve`;
    const account = (
      await client.query(
        `SELECT u.id,u.display_name,u.username FROM users u
      WHERE u.id=$1 AND u.is_active AND u.deleted_at IS NULL AND EXISTS(SELECT 1 FROM user_roles ur
        JOIN role_permissions rp ON rp.role_id=ur.role_id JOIN permissions p ON p.id=rp.permission_id
        WHERE ur.user_id=u.id AND p.code=$2) ${lock ? 'FOR SHARE OF u' : ''}`,
        [id, permission],
      )
    ).rows[0];
    if (!account)
      throw failure('ineligible_officer', 'Choose an active officer with the required role.', 409);
    await independentReviewer(client, account, batch);
    if (
      level !== 'qc' &&
      ((
        await client.query(
          `SELECT 1 FROM qc_reviews r JOIN documents d ON d.id=r.document_id
      WHERE d.batch_id=$1 AND (r.decided_by=$2 OR r.claimed_by=$2) LIMIT 1`,
          [batch.id, id],
        )
      ).rowCount ||
        (
          await client.query(
            `SELECT 1 FROM audit_logs WHERE batch_id=$1 AND actor_id=$2
      AND action IN ('qc.claimed','qc.passed','qc.returned') LIMIT 1`,
            [batch.id, id],
          )
        ).rowCount ||
        (
          await client.query(
            `SELECT 1 FROM approval_decisions a JOIN qc_reviews r ON r.id=a.qc_review_id
         JOIN documents d ON d.id=r.document_id WHERE d.batch_id=$1 AND a.decided_by=$2 AND a.level<>$3
         UNION ALL SELECT 1 FROM publication_withdrawals w JOIN documents d ON d.id=w.document_id
         WHERE d.batch_id=$1 AND w.taken_by=$2 AND $3<>2 LIMIT 1`,
            [batch.id, id, level],
          )
        ).rowCount)
    )
      throw failure(
        'self_approval',
        'Capture, QC, L1 and L2 must remain independent for this document, including after role changes.',
        403,
      );
    return account;
  }
  async function candidates(client, batch, level) {
    const permission = level === 'qc' ? 'qc:review' : `approval_l${level}:approve`;
    const users = (
      await client.query(
        `SELECT u.id FROM users u WHERE u.is_active AND u.deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id
        JOIN permissions p ON p.id=rp.permission_id WHERE ur.user_id=u.id AND p.code=$1) ORDER BY lower(u.display_name),u.id`,
        [permission],
      )
    ).rows;
    const result = [];
    for (const user of users) {
      try {
        result.push(await candidate(client, batch, user.id, level));
      } catch (error) {
        if (!['ineligible_officer', 'self_qc', 'self_approval'].includes(error.code)) throw error;
      }
    }
    return result;
  }
  async function readableSnapshot(client, doc, review) {
    if (
      ['awaiting_approval_l1', 'awaiting_approval_l2', 'approved'].includes(doc.workflow_status) &&
      (!review ||
        review.outcome !== 'passed' ||
        review.reviewed_revision !== doc.revision ||
        review.snapshot?.revision !== doc.revision)
    )
      throw failure(
        'snapshot_conflict',
        'The locked QC revision is unavailable. Ask an administrator to investigate.',
        409,
      );
    return review?.outcome === 'passed' ? review.snapshot : null;
  }
  async function receipt(client, user, id) {
    uuid(id);
    const decision = (
      await client.query(
        `SELECT a.*,r.document_id,r.cycle,r.reviewed_revision,d.batch_id,d.approval_l2_required,
      d.workflow_status,d.review_cycle,d.published_at,a.officer_name AS officer,b.batch_code
      FROM approval_decisions a JOIN qc_reviews r ON r.id=a.qc_review_id JOIN documents d ON d.id=r.document_id
      JOIN archive_batches b ON b.id=d.batch_id JOIN users u ON u.id=a.decided_by
      WHERE a.id=$1 AND a.decision='approved'`,
        [id],
      )
    ).rows[0];
    if (!decision) throw failure('not_found', 'Confirmation not found.', 404);
    const { doc, review } = await load(client, user, decision.batch_id);
    await readableSnapshot(client, doc, review);
    const published = (
      await client.query(
        `SELECT (${finalPublication}) AS published FROM documents d
      LEFT JOIN qc_reviews r ON r.document_id=d.id AND r.cycle=d.review_cycle WHERE d.id=$1`,
        [doc.id],
      )
    ).rows[0].published;
    return {
      ...decision,
      current:
        review?.id === decision.qc_review_id &&
        ['awaiting_approval_l2', 'approved'].includes(doc.workflow_status),
      published: !!published && review?.id === decision.qc_review_id,
      final: decision.level === 2 || decision.approval_l2_required === false,
    };
  }
  const api = {
    async settings(user) {
      requirePermission(user, 'settings:read');
      return { settings: (await pool.query('SELECT * FROM approval_settings')).rows[0] };
    },
    async updateSettings(user, body) {
      requirePermission(user, 'settings:manage');
      keys(body, ['version', 'l2Required', 'l1Label', 'l2Label']);
      if (typeof body.l2Required !== 'boolean')
        throw failure('invalid_request', 'Choose whether L2 is required.');
      const l1 = text(body.l1Label, 80, 'L1 name'),
        l2 = text(body.l2Label, 80, 'L2 name');
      return transaction(pool, async (client) => {
        const current = (await client.query('SELECT * FROM approval_settings FOR UPDATE')).rows[0];
        checkVersion(current, body.version);
        const settings = (
          await client.query(
            `UPDATE approval_settings SET l2_required=$1,l1_label=$2,l2_label=$3,
          version=version+1,updated_by=$4,updated_at=now() RETURNING *`,
            [body.l2Required, l1, l2, user.id],
          )
        ).rows[0];
        await audit(client, user, 'approval.settings_updated', 'approval_settings', null, {
          l2Required: body.l2Required,
          version: settings.version,
        });
        return { settings };
      });
    },
    async list(user, filters) {
      requirePermission(user, 'documents:read');
      const {
        view = 'all',
        search = '',
        status = '',
        type = '',
        number = '',
        location = '',
        operator = '',
        reviewer = '',
        authority = '',
        from = '',
        to = '',
        ocr = '',
        metadata = '',
        sort = 'updated_at',
        direction = 'desc',
        limit = 25,
        offset = 0,
      } = filters;
      if (!['all', 'published', 'l1', 'l2', 'dropped'].includes(view))
        throw failure('invalid_request', 'Invalid document view.');
      if (view === 'l1' || view === 'l2')
        requirePermission(user, `approval_l${view.slice(1)}:review`);
      const statuses = [
        '',
        'capturing',
        'operator_preparation',
        'preparing',
        'qc_waiting',
        'qc_in_review',
        'rework',
        'awaiting_approval_l1',
        'awaiting_approval_l2',
        'approved',
        'dropped',
      ];
      if (
        !statuses.includes(status) ||
        ![
          '',
          'not_queued',
          'queued',
          'running',
          'paused',
          'completed',
          'completed_with_errors',
          'failed',
          'cancelled',
        ].includes(ocr) ||
        ![
          '',
          'pending',
          'not_extracted',
          'needs_review',
          'manually_corrected',
          'verified',
        ].includes(metadata)
      )
        throw failure('invalid_request', 'Invalid status filter.');
      for (const value of [search, type, number, location])
        if (typeof value !== 'string' || value.length > 240)
          throw failure('invalid_request', 'Filter text is too long.');
      for (const value of [operator, reviewer, authority]) if (value) uuid(value);
      for (const value of [from, to])
        if (
          value &&
          (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
            !Number.isFinite(Date.parse(value)) ||
            new Date(value).toISOString().slice(0, 10) !== value)
        )
          throw failure('invalid_request', 'Use a valid YYYY-MM-DD date.');
      if (from && to && from > to)
        throw failure('invalid_request', 'The start date must not follow the end date.');
      const sorts = {
        updated_at: 'b.updated_at',
        created_at: 'b.created_at',
        title: 'd.title',
        workflow_status: 'd.workflow_status',
        page_count: 'page_count',
        published_at: 'd.published_at',
      };
      if (!Object.hasOwn(sorts, sort) || !['asc', 'desc'].includes(direction))
        throw failure('invalid_request', 'Invalid document sort.');
      const source = `FROM archive_batches b JOIN LATERAL (SELECT * FROM documents WHERE batch_id=b.id ORDER BY document_index LIMIT 1) d ON true
        LEFT JOIN qc_reviews r ON r.document_id=d.id AND r.cycle=d.review_cycle
        LEFT JOIN users op ON op.id=b.assigned_operator_id LEFT JOIN users qc ON qc.id=coalesce(r.assigned_reviewer_id,r.decided_by,r.claimed_by)
        LEFT JOIN users l2 ON l2.id=d.assigned_l2_id`;
      const access = `b.deleted_at IS NULL AND ${scope(user)}`;
      const where = `WHERE ${access}
        AND CASE $2 WHEN 'published' THEN (${finalPublication}) WHEN 'l1' THEN d.workflow_status='awaiting_approval_l1'
          WHEN 'l2' THEN d.workflow_status='awaiting_approval_l2' AND d.assigned_l2_id=$1 WHEN 'dropped' THEN d.workflow_status='dropped' ELSE true END
        AND ($3='' OR strpos(lower(concat_ws(' ',b.batch_code,d.title,d.archive_number,d.document_type,b.physical_location)),lower($3))>0)
        AND ($4='' OR d.workflow_status=$4) AND ($5='' OR strpos(lower(coalesce(d.document_type,'')),lower($5))>0)
        AND ($6='' OR strpos(lower(coalesce(d.archive_number,'')),lower($6))>0) AND ($7='' OR strpos(lower(coalesce(b.physical_location,'')),lower($7))>0)
        AND ($8::uuid IS NULL OR b.assigned_operator_id=$8) AND ($9::uuid IS NULL OR coalesce(r.assigned_reviewer_id,r.decided_by,r.claimed_by)=$9)
        AND ($10::uuid IS NULL OR d.assigned_l2_id=$10) AND ($11::date IS NULL OR b.created_at >= ($11::date::timestamp AT TIME ZONE 'Asia/Jakarta'))
        AND ($12::date IS NULL OR b.created_at < (($12::date+1)::timestamp AT TIME ZONE 'Asia/Jakarta'))
        AND ($13='' OR coalesce(b.ocr_status,'not_queued')=$13) AND ($14='' OR d.metadata_status=$14)`;
      const args = [
        user.id,
        view,
        search.trim(),
        status,
        type.trim(),
        number.trim(),
        location.trim(),
        operator || null,
        reviewer || null,
        authority || null,
        from || null,
        to || null,
        ocr,
        metadata,
      ];
      return transaction(pool, async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const records = (
          await client.query(
            `SELECT b.id,b.batch_code,b.physical_location,b.created_at,b.updated_at,b.ocr_status,
          d.title,d.archive_number,d.document_type,d.workflow_status,d.metadata_status,d.published_at,d.approval_l2_required,
          op.display_name AS operator,qc.display_name AS reviewer,l2.display_name AS authority,
          (SELECT count(*)::int FROM pages p WHERE p.batch_id=b.id AND NOT p.is_excluded AND NOT p.replacement_candidate) AS page_count
          ${source} ${where} ORDER BY ${sorts[sort]} ${direction.toUpperCase()} NULLS LAST,b.id LIMIT $15 OFFSET $16`,
            [...args, limit, offset],
          )
        ).rows;
        const total = (await client.query(`SELECT count(*)::int AS total ${source} ${where}`, args))
          .rows[0].total;
        const counts = (
          await client.query(
            `SELECT count(*)::int AS "all",count(*) FILTER(WHERE ${finalPublication})::int AS published,
          count(*) FILTER(WHERE d.workflow_status='dropped')::int AS dropped ${source} WHERE ${access}`,
            [user.id],
          )
        ).rows[0];
        const people = (
          await client.query(
            `SELECT DISTINCT u.id,u.display_name FROM users u WHERE EXISTS
          (SELECT 1 ${source} WHERE ${access} AND u.id IN(b.assigned_operator_id,r.assigned_reviewer_id,r.decided_by,r.claimed_by,d.assigned_l2_id)) ORDER BY u.display_name,u.id`,
            [user.id],
          )
        ).rows;
        return {
          records,
          total,
          counts,
          people,
          settings: (await client.query('SELECT * FROM approval_settings')).rows[0],
        };
      });
    },
    async get(user, batchId) {
      return transaction(pool, async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const { batch, doc, review } = await load(client, user, batchId);
        const snapshot = await readableSnapshot(client, doc, review);
        const pages =
          snapshot?.pages ||
          (
            await client.query(
              'SELECT * FROM document_pages WHERE batch_id=$1 AND NOT is_excluded AND NOT replacement_candidate ORDER BY display_order,capture_order',
              [batchId],
            )
          ).rows.map(publicPage);
        const history = (
          await client.query(
            `SELECT a.*,a.officer_name AS officer,r.cycle FROM approval_decisions a JOIN qc_reviews r ON r.id=a.qc_review_id
          JOIN users u ON u.id=a.decided_by WHERE r.document_id=$1 ORDER BY a.decided_at DESC,a.id`,
            [doc.id],
          )
        ).rows;
        let level =
          doc.workflow_status === 'awaiting_approval_l1'
            ? 1
            : doc.workflow_status === 'awaiting_approval_l2'
              ? 2
              : null;
        let canDecide = false,
          blocked = '';
        if (level && user.permissions.includes(`approval_l${level}:approve`)) {
          try {
            await candidate(client, batch, user.id, level);
            if (level === 2 && doc.assigned_l2_id !== user.id)
              blocked = 'Only the L2 authority selected by L1 can decide.';
            else canDecide = true;
          } catch (error) {
            if (!['self_qc', 'self_approval', 'ineligible_officer'].includes(error.code))
              throw error;
            blocked = error.message;
          }
        }
        let canAssign = false;
        if (
          doc.workflow_status === 'awaiting_approval_l2' &&
          user.permissions.includes('approval_l1:approve')
        ) {
          try {
            await candidate(client, batch, user.id, 1);
            canAssign = true;
          } catch (error) {
            if (!['self_qc', 'self_approval', 'ineligible_officer'].includes(error.code))
              throw error;
          }
        }
        let canTakeDown = false;
        if (doc.workflow_status === 'approved' && user.permissions.includes('approval_l2:reject')) {
          try {
            await candidate(client, batch, user.id, 2);
            canTakeDown = true;
          } catch (error) {
            if (!['self_qc', 'self_approval', 'ineligible_officer'].includes(error.code))
              throw error;
          }
        }
        const withdrawals = (
          await client.query(
            'SELECT * FROM publication_withdrawals WHERE document_id=$1 ORDER BY taken_at DESC,id',
            [doc.id],
          )
        ).rows;
        const qcCandidates = canDecide || canTakeDown ? await candidates(client, batch, 'qc') : [];
        const l2Candidates =
          (canDecide && level === 1 && doc.approval_l2_required) || canAssign
            ? await candidates(client, batch, 2)
            : [];
        return {
          batch: {
            id: batch.id,
            batch_code: batch.batch_code,
            physical_location: batch.physical_location,
            assigned_operator_id: batch.assigned_operator_id,
          },
          document: doc,
          review: review
            ? {
                id: review.id,
                decided_by: review.decided_by,
                decided_at: review.decided_at,
                decision_reason: review.decision_reason,
                ocr_exception: review.ocr_exception,
                approval_return_reason: review.approval_return_reason,
                carried_from_review_id: review.carried_from_review_id,
              }
            : null,
          metadata: snapshot?.metadata || metadataOf(doc),
          pages,
          findings: snapshot?.findings || [],
          history,
          snapshot: !!snapshot,
          level,
          canDecide,
          canAssign,
          canTakeDown,
          withdrawals,
          blocked,
          qcCandidates,
          l2Candidates,
          settings: (await client.query('SELECT * FROM approval_settings')).rows[0],
        };
      });
    },
    async page(user, batchId, pageId, size) {
      uuid(pageId);
      return transaction(pool, async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const { doc, review } = await load(client, user, batchId);
        const snapshot = await readableSnapshot(client, doc, review);
        const page = (
          await client.query('SELECT * FROM document_pages WHERE id=$1 AND batch_id=$2', [
            pageId,
            batchId,
          ])
        ).rows[0];
        const saved = snapshot?.pages.find((p) => p.id === pageId);
        if (
          !page ||
          (snapshot && !saved) ||
          (!snapshot && (page.is_excluded || page.replacement_candidate))
        )
          throw failure('not_found', 'Page is not part of this document revision.', 404);
        if (size === 'text') {
          if (!snapshot) return { ocr: (await currentOcr(client, batchId, { pageId }))[0] || null };
          const entry = snapshot.ocr.find((p) => p.page_id === pageId);
          if (!entry?.result_id) return { ocr: null };
          const ocr = (
            await client.query(
              `SELECT r.id AS result_id,r.status,r.engine,r.engine_version,
          coalesce(r.extracted_text,reused.extracted_text) AS extracted_text,c.corrected_text
          FROM page_ocr_results r LEFT JOIN page_ocr_results reused ON reused.id=r.reused_result_id
           LEFT JOIN ocr_text_corrections c ON c.id=$2 AND c.result_id IN
             (SELECT id FROM page_ocr_results corrected WHERE corrected.page_id=r.page_id
               AND corrected.image_revision=r.image_revision
               AND coalesce(corrected.reused_result_id,corrected.id)=coalesce(r.reused_result_id,r.id))
          WHERE r.id=$1 AND r.page_id=$3`,
              [entry.result_id, entry.correction_id, pageId],
            )
          ).rows[0];
          return { ocr: ocr || null };
        }
        let key = page.active_storage_key;
        if (saved) {
          const sha = saved.active_image_sha256;
          if (page.active_image_sha256 === sha) key = page.active_storage_key;
          else if (page.sha256 === sha) key = page.original_storage_key;
          else
            key = (
              await client.query(
                'SELECT storage_key FROM page_revisions WHERE page_id=$1 AND sha256=$2 ORDER BY created_at LIMIT 1',
                [pageId, sha],
              )
            ).rows[0]?.storage_key;
          if (!key)
            throw failure('snapshot_image_missing', 'The reviewed image is unavailable.', 409);
          await storage.ocrImage({ storage_key: key, image_sha256: sha });
        }
        return {
          file:
            size === 'image'
              ? await storage.open(key)
              : await storage.derivative({ active_storage_key: key }, size),
          mime: size === 'image' ? 'image/png' : 'image/webp',
        };
      });
    },
    async decide(user, batchId, body) {
      if (body?.action === 'take-down') return api.takeDown(user, batchId, body);
      keys(body, ['version', 'action', 'reason', 'reviewerId', 'authorityId']);
      if (!['approve', 'return', 'drop', 'assign-l2'].includes(body.action))
        throw failure('invalid_request', 'Choose an approval action.');
      const reason = text(body.reason ?? '', 2000, 'Decision reason', body.action === 'approve');
      return transaction(pool, async (client) => {
        const { batch, doc, review } = await load(client, user, batchId, true);
        checkVersion(doc, body.version);
        await noCapture(client, batchId);
        const level =
          body.action === 'assign-l2'
            ? 1
            : doc.workflow_status === 'awaiting_approval_l1'
              ? 1
              : doc.workflow_status === 'awaiting_approval_l2'
                ? 2
                : null;
        if (
          !level ||
          (body.action === 'assign-l2' && doc.workflow_status !== 'awaiting_approval_l2')
        )
          throw failure('workflow_locked', 'This document is not awaiting that approval.', 409);
        requirePermission(
          user,
          `approval_l${level}:${body.action === 'return' || body.action === 'drop' ? 'reject' : 'approve'}`,
        );
        const actor = await candidate(client, batch, user.id, level);
        await readableSnapshot(client, doc, review);
        if (
          typeof doc.approval_l2_required !== 'boolean' ||
          !Number.isSafeInteger(doc.approval_policy_version)
        )
          throw failure(
            'approval_policy_missing',
            'This batch has no fixed approval policy. Ask an administrator to investigate.',
            409,
          );
        if (level === 2 && doc.assigned_l2_id !== user.id)
          throw failure('not_assigned', 'Only the L2 authority selected by L1 can decide.', 403);
        if (
          level === 2 &&
          !(
            await client.query(
              "SELECT 1 FROM approval_decisions WHERE qc_review_id=$1 AND level=1 AND decision='approved'",
              [review.id],
            )
          ).rowCount
        )
          throw failure('approval_order', 'L1 must approve this revision first.', 409);
        if (body.action === 'assign-l2') {
          const officer = await candidate(client, batch, body.authorityId, 2, true);
          await client.query(
            'UPDATE documents SET assigned_l2_id=$2,version=version+1,updated_at=now() WHERE id=$1',
            [doc.id, officer.id],
          );
          await audit(
            client,
            user,
            'approval.l2_reassigned',
            'document',
            doc.id,
            { previous: doc.assigned_l2_id, authorityId: officer.id, reason },
            batchId,
          );
          return { saved: true };
        }
        let authority = null,
          reviewer = null;
        if (body.action === 'approve' && level === 1 && doc.approval_l2_required)
          authority = await candidate(client, batch, body.authorityId, 2, true);
        if (authority?.id === user.id)
          throw failure('self_approval', 'L1 and L2 must be different people.', 403);
        if (body.action === 'return')
          reviewer = await candidate(client, batch, body.reviewerId, 'qc', true);
        const decision = (
          await client.query(
            `INSERT INTO approval_decisions(qc_review_id,level,decision,decided_by,reason,nominated_l2_id,returned_to,officer_name)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [
              review.id,
              level,
              { approve: 'approved', return: 'returned', drop: 'dropped' }[body.action],
              user.id,
              reason,
              authority?.id || null,
              reviewer?.id || null,
              actor.display_name,
            ],
          )
        ).rows[0];
        let state;
        if (body.action === 'return') {
          state = 'qc_waiting';
          await client.query(
            `INSERT INTO qc_reviews(document_id,cycle,submitted_at,assigned_reviewer_id,approval_return_reason)
            VALUES($1,$2,now(),$3,$4)`,
            [doc.id, doc.review_cycle + 1, reviewer.id, reason],
          );
          await client.query(
            'UPDATE documents SET review_cycle=review_cycle+1,assigned_l2_id=NULL WHERE id=$1',
            [doc.id],
          );
        } else if (body.action === 'drop') {
          state = 'dropped';
          await client.query(
            "UPDATE documents SET workflow_status='dropped',version=version+1,updated_at=now() WHERE batch_id=$1 AND id<>$2",
            [batchId, doc.id],
          );
        } else
          state = level === 1 && doc.approval_l2_required ? 'awaiting_approval_l2' : 'approved';
        await client.query(
          `UPDATE documents SET workflow_status=$2,assigned_l2_id=CASE WHEN $2='awaiting_approval_l2' THEN $3 ELSE assigned_l2_id END,
          published_at=CASE WHEN $2='approved' THEN now() ELSE NULL END,published_by=CASE WHEN $2='approved' THEN $4::uuid ELSE NULL END,
          version=version+1,updated_at=now() WHERE id=$1`,
          [doc.id, state, authority?.id || null, user.id],
        );
        await client.query(
          'UPDATE archive_batches SET version=version+1,updated_at=now() WHERE id=$1',
          [batchId],
        );
        await audit(
          client,
          user,
          `approval.${body.action === 'approve' ? (state === 'approved' ? 'published' : 'l1_approved') : body.action === 'return' ? 'returned' : 'dropped'}`,
          'document',
          doc.id,
          {
            level,
            reason,
            cycle: doc.review_cycle,
            revision: doc.revision,
            decisionId: decision.id,
            authorityId: authority?.id || null,
            reviewerId: reviewer?.id || null,
          },
          batchId,
        );
        return {
          saved: true,
          state,
          confirmationId: body.action === 'approve' ? decision.id : null,
        };
      });
    },
    async takeDown(user, batchId, body) {
      requirePermission(user, 'approval_l2:reject');
      keys(body, ['version', 'action', 'target', 'reason', 'reviewerId']);
      const reason = text(body.reason, 2000, 'Takedown reason');
      if (!['qc', 'l1'].includes(body.target))
        throw failure('invalid_request', 'Choose QC or L1 as the destination.');
      return transaction(pool, async (client) => {
        const { batch, doc, review } = await load(client, user, batchId, true);
        checkVersion(doc, body.version);
        await noCapture(client, batchId);
        const actor = await candidate(client, batch, user.id, 2);
        const published = (
          await client.query(
            `SELECT (${finalPublication}) AS published FROM documents d
          LEFT JOIN qc_reviews r ON r.document_id=d.id AND r.cycle=d.review_cycle WHERE d.id=$1`,
            [doc.id],
          )
        ).rows[0].published;
        if (!published || !doc.published_at)
          throw failure(
            'workflow_locked',
            'Only a currently published document can be taken down.',
            409,
          );
        const reviewer =
          body.target === 'qc' ? await candidate(client, batch, body.reviewerId, 'qc', true) : null;
        let next;
        if (body.target === 'qc') {
          next = (
            await client.query(
              `INSERT INTO qc_reviews(document_id,cycle,submitted_at,assigned_reviewer_id,approval_return_reason)
            VALUES($1,$2,now(),$3,$4) RETURNING id`,
              [doc.id, doc.review_cycle + 1, reviewer.id, reason],
            )
          ).rows[0];
        } else {
          // Reuse the signed QC result explicitly; this is not a new QC inspection.
          next = (
            await client.query(
              `INSERT INTO qc_reviews(document_id,cycle,submitted_at,outcome,ordering_reviewed,completeness_reviewed,
            metadata_reviewed,ocr_exception,notes,decision_reason,decided_by,decided_at,reviewed_revision,snapshot,approval_return_reason,carried_from_review_id)
            SELECT document_id,$2,now(),outcome,ordering_reviewed,completeness_reviewed,metadata_reviewed,ocr_exception,notes,
              decision_reason,decided_by,decided_at,reviewed_revision,snapshot,$3,id FROM qc_reviews WHERE id=$1 RETURNING id`,
              [review.id, doc.review_cycle + 1, reason],
            )
          ).rows[0];
          await client.query(
            `INSERT INTO qc_page_reviews(review_id,page_id,status,image_revision,reviewed_by,reviewed_at)
            SELECT $1,page_id,status,image_revision,reviewed_by,reviewed_at FROM qc_page_reviews WHERE review_id=$2`,
            [next.id, review.id],
          );
        }
        const withdrawal = (
          await client.query(
            `INSERT INTO publication_withdrawals(document_id,qc_review_id,resumed_review_id,revision,prior_published_at,target,reason,taken_by,officer_name)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [
              doc.id,
              review.id,
              next.id,
              doc.revision,
              doc.published_at,
              body.target,
              reason,
              user.id,
              actor.display_name,
            ],
          )
        ).rows[0];
        const state = body.target === 'qc' ? 'qc_waiting' : 'awaiting_approval_l1';
        await client.query(
          `UPDATE documents SET workflow_status=$2,review_cycle=review_cycle+1,assigned_l2_id=NULL,
          published_at=NULL,published_by=NULL,version=version+1,updated_at=now() WHERE id=$1`,
          [doc.id, state],
        );
        await client.query(
          'UPDATE archive_batches SET version=version+1,updated_at=now() WHERE id=$1',
          [batchId],
        );
        await audit(
          client,
          user,
          'approval.taken_down',
          'document',
          doc.id,
          {
            withdrawalId: withdrawal.id,
            target: body.target,
            reason,
            revision: doc.revision,
            fromCycle: doc.review_cycle,
            toCycle: doc.review_cycle + 1,
            sourceReviewId: review.id,
            resumedReviewId: next.id,
            reviewerId: reviewer?.id || null,
          },
          batchId,
        );
        return { saved: true, state };
      });
    },
    async confirmation(user, id) {
      return transaction(pool, async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        return { confirmation: await receipt(client, user, id) };
      });
    },
    async qr(user, id, origin) {
      await api.confirmation(user, id);
      const svg = await QRCode.toString(`${origin}/confirmations/${id}`, {
        type: 'svg',
        width: 240,
        margin: 4,
        errorCorrectionLevel: 'M',
      });
      return { buffer: Buffer.from(svg), mime: 'image/svg+xml' };
    },
    async notifications(user) {
      requirePermission(user, 'batches:read');
      requirePermission(user, 'documents:read');
      const notifications = (
        await pool.query(
          `SELECT a.id,a.level,a.decided_at,b.id AS batch_id,b.batch_code,
        r.cycle,d.review_cycle,d.workflow_status,(a.level=2 OR NOT d.approval_l2_required) AS final
        FROM approval_decisions a JOIN qc_reviews r ON r.id=a.qc_review_id JOIN documents d ON d.id=r.document_id
        JOIN archive_batches b ON b.id=d.batch_id WHERE b.assigned_operator_id=$1 AND b.deleted_at IS NULL AND a.decision='approved'
        AND NOT EXISTS(SELECT 1 FROM approval_notification_reads n WHERE n.user_id=$1 AND n.decision_id=a.id)
        ORDER BY a.decided_at DESC,a.id LIMIT 20`,
          [user.id],
        )
      ).rows;
      return { notifications };
    },
    async dismiss(user, id, body) {
      keys(body, []);
      const item = await receipt(pool, user, id);
      const { batch } = await load(pool, user, item.batch_id);
      if (batch.assigned_operator_id !== user.id)
        throw failure('forbidden', 'This notification belongs to the assigned operator.', 403);
      await pool.query(
        'INSERT INTO approval_notification_reads(user_id,decision_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [user.id, id],
      );
      return { saved: true };
    },
  };
  return api;
}
