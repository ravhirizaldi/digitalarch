import { keys, requirePermission } from './auth.mjs';
import { transaction } from './db.mjs';
import { failure } from './errors.mjs';
import { approvalScope } from './approvals.mjs';

const labels = {
  'qc.submitted': 'Sent to QC',
  'qc.resubmitted': 'Resubmitted to QC',
  'qc.claimed': 'QC review started',
  'qc.released': 'QC review released',
  'qc.reassigned': 'QC assignment changed',
  'qc.passed': 'QC passed — awaiting L1',
  'qc.returned': 'QC returned for correction',
  'approval.l1_approved': 'L1 approved — awaiting L2',
  'approval.published': 'Publication approved — QR ready',
  'approval.returned': 'Approval returned to QC',
  'approval.dropped': 'Batch dropped without publication',
  'approval.taken_down': 'Publication taken down',
  'approval.l2_reassigned': 'L2 assignment changed',
  'batch.reassigned': 'Operator assignment changed',
};
function eventId(value) {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d{0,18}$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw failure('invalid_request', 'Invalid notification cursor.');
  return value;
}

export function notificationDestination(item, user) {
  if (!item.can_view) return null;
  if (
    ['approval.l1_approved', 'approval.l2_reassigned'].includes(item.action) &&
    item.workflow_status === 'awaiting_approval_l2' &&
    item.assigned_l2_id === user.id
  )
    return { view: 'record', id: item.batch_id, label: 'Review L2 approval' };
  if (item.decision_id)
    return {
      view: 'confirmation',
      id: item.decision_id,
      label: item.current_confirmation ? 'View / download QR' : 'View historical QR',
    };
  const operator = item.assigned_operator_id === user.id;
  if (
    operator &&
    item.workflow_status === 'capturing' &&
    item.capture_status !== 'capture_completed'
  )
    return { view: 'scanner', id: item.batch_id, label: 'Continue rework / capture' };
  if (
    (operator || user.permissions.includes('qc:read')) &&
    !['awaiting_approval_l1', 'awaiting_approval_l2', 'approved', 'dropped'].includes(
      item.workflow_status,
    )
  )
    return {
      view: 'document',
      id: item.batch_id,
      label: item.workflow_status === 'rework' ? 'View findings / rework' : 'Open QC / document',
    };
  return { view: 'record', id: item.batch_id, label: 'View document / approval' };
}

export function staffNotifications(pool, auth) {
  const subscribers = new Map();
  let listener;
  let prefix;
  const permit = (user) => requirePermission(user, 'notifications:read');
  function invalidate(userId) {
    for (const stream of subscribers.get(userId) || []) stream.send();
  }
  function disconnect() {
    for (const streams of subscribers.values()) for (const stream of [...streams]) stream.close();
  }
  function onNotification(message) {
    if (
      message.channel === 'digitalarch_staff_notifications' &&
      message.payload?.startsWith(prefix)
    )
      invalidate(message.payload.slice(prefix.length));
  }
  async function summary(client, user) {
    return (
      await client.query(
        `SELECT
      (SELECT count(*)::integer FROM staff_notification_recipients WHERE user_id=$1 AND read_at IS NULL) AS unread,
      coalesce((SELECT event_id FROM staff_notification_recipients WHERE user_id=$1 ORDER BY event_id DESC LIMIT 1),0)::text AS latest`,
        [user.id],
      )
    ).rows[0];
  }
  return {
    async listen(client) {
      if (listener) listener.off('notification', onNotification);
      const result = await client.query(
        "SELECT current_database()||':'||current_schema()||':' AS prefix",
      );
      prefix = result.rows[0].prefix;
      client.on('notification', onNotification);
      try {
        await client.query('LISTEN digitalarch_staff_notifications');
      } catch (error) {
        client.off('notification', onNotification);
        throw error;
      }
      listener = client;
    },
    disconnect,
    async close() {
      disconnect();
      if (listener) {
        listener.off('notification', onNotification);
        await listener.query('UNLISTEN digitalarch_staff_notifications').catch(() => {});
        listener = null;
      }
    },
    async summary(user) {
      permit(user);
      return summary(pool, user);
    },
    async list(user, params) {
      permit(user);
      const filter = params.get('filter') || 'all';
      if (!['all', 'unread'].includes(filter))
        throw failure('invalid_request', 'Choose All or Unread.');
      const before = params.has('before') ? eventId(params.get('before')) : null;
      return transaction(pool, async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const rows = (
          await client.query(
            `SELECT e.*,n.read_at,n.viewed_at,
           CASE WHEN ${user.permissions.includes('documents:read') ? 'true' : 'false'} AND b.deleted_at IS NULL AND ${approvalScope(user)} THEN true ELSE false END AS can_view,
           d.workflow_status,d.review_cycle AS current_cycle,d.assigned_l2_id,b.status AS capture_status,b.assigned_operator_id,
          r.claimed_by,r.claim_expires_at,r.assigned_reviewer_id,
          e.decision_id IS NOT NULL AND a.qc_review_id=r.id AND d.workflow_status IN ('awaiting_approval_l2','approved') AS current_confirmation
          FROM staff_notification_recipients n JOIN staff_notification_events e ON e.id=n.event_id
          JOIN archive_batches b ON b.id=e.batch_id JOIN documents d ON d.id=e.document_id
          LEFT JOIN qc_reviews r ON r.document_id=d.id AND r.cycle=d.review_cycle
          LEFT JOIN approval_decisions a ON a.id=e.decision_id
          WHERE n.user_id=$1 ${filter === 'unread' ? 'AND n.read_at IS NULL' : ''}
          ${before ? 'AND n.event_id<$2' : ''} ORDER BY n.event_id DESC LIMIT 26`,
            before ? [user.id, before] : [user.id],
          )
        ).rows;
        const more = rows.length > 25;
        const notifications = rows.slice(0, 25).map((row) => ({
          id: row.id,
          batch_id: row.batch_id,
          title: row.title,
          batch_code: row.batch_code,
          action: row.action,
          label: labels[row.action] || row.action,
          actor: row.actor_name,
          reason: row.reason,
          created_at: row.created_at,
          read_at: row.read_at,
          viewed_at: row.viewed_at,
          stage: !row.can_view
            ? 'Access changed / document unavailable'
            : row.review_cycle !== row.current_cycle
              ? 'Historical cycle'
              : row.workflow_status === 'qc_in_review' &&
                  row.claimed_by &&
                  new Date(row.claim_expires_at) > new Date()
                ? row.claimed_by === user.id
                  ? 'Claimed by you'
                  : 'Already claimed'
                : row.workflow_status,
          destination: notificationDestination(row, user),
        }));
        return {
          ...(await summary(client, user)),
          notifications,
          next: more ? notifications.at(-1).id : null,
        };
      });
    },
    async update(user, id, body) {
      permit(user);
      keys(body, ['action', 'through']);
      let state;
      if (id === null) {
        if (body.action !== 'read-all')
          throw failure('invalid_request', 'Invalid notification action.');
        const through = eventId(body.through);
        await pool.query(
          `UPDATE staff_notification_recipients SET read_at=now()
          WHERE user_id=$1 AND event_id<=$2 AND read_at IS NULL`,
          [user.id, through],
        );
      } else {
        eventId(id);
        if (body.through !== undefined || !['read', 'unread', 'view'].includes(body.action))
          throw failure('invalid_request', 'Invalid notification action.');
        let result = await pool.query(
          `UPDATE staff_notification_recipients
          SET read_at=CASE WHEN $3='unread' THEN NULL ELSE coalesce(read_at,now()) END,
          viewed_at=CASE WHEN $3='view' THEN coalesce(viewed_at,now()) ELSE viewed_at END
          WHERE user_id=$1 AND event_id=$2 AND (
            ($3='unread' AND read_at IS NOT NULL) OR ($3 IN ('read','view') AND read_at IS NULL)
            OR ($3='view' AND viewed_at IS NULL)) RETURNING read_at,viewed_at`,
          [user.id, id, body.action],
        );
        if (!result.rowCount)
          result = await pool.query(
            'SELECT read_at,viewed_at FROM staff_notification_recipients WHERE user_id=$1 AND event_id=$2',
            [user.id, id],
          );
        if (!result.rowCount) throw failure('not_found', 'Notification not found.', 404);
        state = result.rows[0];
      }
      return { saved: true, ...(state ? { state } : {}) };
    },
    stream(req, res, user) {
      permit(user);
      if (req.method !== 'GET') throw failure('invalid_request', 'Use GET for live notifications.');
      let streams = subscribers.get(user.id);
      if (
        (streams?.size || 0) >= 8 ||
        [...subscribers.values()].reduce((total, set) => total + set.size, 0) >= 200
      )
        throw failure('rate_limited', 'Too many notification connections. Close unused tabs.', 429);
      if (!streams) {
        streams = new Set();
        subscribers.set(user.id, streams);
      }
      let pending;
      let checking = false;
      let closed = false;
      let heartbeat;
      const stream = {
        send() {
          if (pending || closed) return;
          pending = setTimeout(() => {
            pending = null;
            if (!res.write('event: inbox\ndata: {}\n\n')) stream.close();
          }, 250);
        },
        close() {
          if (closed) return;
          closed = true;
          clearTimeout(pending);
          clearInterval(heartbeat);
          streams.delete(stream);
          if (!streams.size) subscribers.delete(user.id);
          res.end();
        },
      };
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 5000\nevent: inbox\ndata: {}\n\n');
      streams.add(stream);
      res.once('close', stream.close);
      res.once('error', stream.close);
      // Revalidate revoked sessions/role changes without per-client inbox polling.
      heartbeat = setInterval(async () => {
        if (checking || closed) return;
        checking = true;
        try {
          const context = await auth.authenticate(req);
          permit(context.user);
          if (context.user.id !== user.id || context.user.must_change_password)
            return stream.close();
          if (!closed && !res.write(': keep-alive\n\n')) stream.close();
        } catch {
          stream.close();
        } finally {
          checking = false;
        }
      }, 30000);
      heartbeat.unref();
      return { streaming: true };
    },
  };
}
