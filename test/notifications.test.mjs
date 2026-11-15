import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { audit } from '../server/auth.mjs';
import { transaction } from '../server/db.mjs';
import { notificationDestination, staffNotifications } from '../server/notifications.mjs';
import { testApplication } from './support.mjs';

// Notification state only: no captured pages, OCR fixtures, recognition or browser operations.
async function fixture(t) {
  const f = await testApplication(t);
  f.app.qc.refresh = async () => {};
  const op = await f.account();
  const qc = await f.account(['qc_officer']);
  const otherQc = await f.account(['qc_officer']);
  const l1 = await f.account(['approver_l1']);
  const l2 = await f.account(['approver_l2']);
  const outsider = await f.account();
  const batch = (await op.request('/api/batches', {})).body.batch;
  const doc = (
    await f.pool.query(
      `UPDATE documents SET title='Notification fixture',review_cycle=1,
    workflow_status='qc_waiting' WHERE batch_id=$1 RETURNING *`,
      [batch.id],
    )
  ).rows[0];
  const review = (
    await f.pool.query(
      `INSERT INTO qc_reviews(document_id,cycle,submitted_at,submitted_by)
    VALUES($1,1,now(),$2) RETURNING *`,
      [doc.id, op.user.id],
    )
  ).rows[0];
  const emit = (actor, action, metadata = {}, client = f.pool) =>
    audit(client, actor.user, action, 'document', doc.id, metadata, batch.id);
  const inbox = async (account, query = '') => {
    const result = await account.request(`/api/notifications${query}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  return { ...f, op, qc, otherQc, l1, l2, outsider, batch, doc, review, emit, inbox };
}

test('shared QC/L1 queues, per-user reads/views, rollback, and ownership', async (t) => {
  const f = await fixture(t);
  const viewer = await f.account(['archive_viewer']);
  assert.equal((await viewer.request('/api/notifications')).status, 403);
  await f.emit(f.op, 'qc.submitted', { cycle: 1 });
  const first = (await f.inbox(f.qc)).notifications[0];
  assert.equal(first.action, 'qc.submitted');
  assert.equal((await f.inbox(f.otherQc)).unread, 1);
  assert.equal((await f.inbox(f.op)).unread, 0, 'Do not notify the acting operator');
  assert.equal((await f.inbox(f.outsider)).notifications.length, 0);
  assert.equal(
    (await f.outsider.request(`/api/notifications/${first.id}`, { action: 'view' })).status,
    404,
  );
  const viewed = await f.qc.request(`/api/notifications/${first.id}`, { action: 'view' });
  assert.equal(viewed.status, 200);
  assert.ok(viewed.body.state.read_at);
  assert.ok(viewed.body.state.viewed_at);
  assert.equal((await f.inbox(f.qc, '?filter=unread')).notifications.length, 0);
  assert.equal((await f.inbox(f.otherQc)).unread, 1, 'Reading is not shared');
  await f.qc.request(`/api/notifications/${first.id}`, { action: 'unread' });
  const unread = (await f.inbox(f.qc)).notifications[0];
  assert.equal(unread.read_at, null);
  assert.ok(unread.viewed_at, 'Mark unread retains view history');
  const before = (await f.pool.query('SELECT count(*) FROM staff_notification_events')).rows[0]
    .count;
  await assert.rejects(
    transaction(f.pool, async (client) => {
      await f.emit(f.qc, 'qc.claimed', { cycle: 1 }, client);
      throw new Error('rollback fixture');
    }),
    /rollback fixture/,
  );
  assert.equal(
    (await f.pool.query('SELECT count(*) FROM staff_notification_events')).rows[0].count,
    before,
  );
  await f.pool.query(
    'SELECT staff_notification_record(a) FROM audit_logs a WHERE id=(SELECT audit_id FROM staff_notification_events WHERE id=$1)',
    [first.id],
  );
  assert.equal(
    (await f.pool.query('SELECT count(*) FROM staff_notification_events')).rows[0].count,
    before,
    'Replay is idempotent',
  );
  await assert.rejects(
    f.pool.query('UPDATE staff_notification_events SET title=$1 WHERE id=$2', [
      'changed',
      first.id,
    ]),
    /append-only/,
  );
  await f.pool.query(
    `UPDATE qc_reviews SET claimed_by=$2,claim_expires_at=now()+interval '30 minutes' WHERE id=$1`,
    [f.review.id, f.qc.user.id],
  );
  await f.pool.query("UPDATE documents SET workflow_status='qc_in_review' WHERE id=$1", [f.doc.id]);
  assert.equal((await f.inbox(f.otherQc)).notifications[0].stage, 'Already claimed');
  await transaction(f.pool, async (client) => {
    await client.query(
      `UPDATE qc_reviews SET outcome='passed',decided_by=$2,decided_at=now(),
      claimed_by=NULL,claim_expires_at=NULL WHERE id=$1`,
      [f.review.id, f.qc.user.id],
    );
    await client.query("UPDATE documents SET workflow_status='awaiting_approval_l1' WHERE id=$1", [
      f.doc.id,
    ]);
    await f.emit(f.qc, 'qc.passed', { cycle: 1 }, client);
  });
  assert.equal((await f.inbox(f.op)).notifications[0].label, 'QC passed — awaiting L1');
  assert.equal((await f.inbox(f.l1)).notifications[0].action, 'qc.passed');
  assert.equal((await f.inbox(f.l2)).unread, 0);
  for (const cursor of ['0', '-1', '1.5', '9223372036854775808', 'x'])
    assert.equal((await f.qc.request(`/api/notifications?before=${cursor}`)).status, 400);
});

test('final publication reaches OP/QC/L1, selected L2 only gets its task, and withdrawn QR becomes historical', async (t) => {
  const f = await fixture(t);
  await f.pool.query(
    `UPDATE qc_reviews SET outcome='passed',decided_by=$2,decided_at=now(),
    reviewed_revision=$3,snapshot=$4 WHERE id=$1`,
    [f.review.id, f.qc.user.id, f.doc.revision, JSON.stringify({ revision: f.doc.revision })],
  );
  await f.pool.query(
    `UPDATE documents SET approval_l2_required=true,approval_policy_version=1,
    assigned_l2_id=$2,workflow_status='awaiting_approval_l2' WHERE id=$1`,
    [f.doc.id, f.l2.user.id],
  );
  const l1Decision = (
    await f.pool.query(
      `INSERT INTO approval_decisions(qc_review_id,level,decision,decided_by,officer_name,nominated_l2_id)
    VALUES($1,1,'approved',$2,'L1 fixture',$3) RETURNING id`,
      [f.review.id, f.l1.user.id, f.l2.user.id],
    )
  ).rows[0].id;
  await f.emit(f.l1, 'approval.l1_approved', {
    cycle: 1,
    decisionId: l1Decision,
    authorityId: f.l2.user.id,
  });
  assert.equal((await f.inbox(f.l2)).notifications[0].action, 'approval.l1_approved');
  assert.equal((await f.inbox(f.l2)).notifications[0].destination.label, 'Review L2 approval');
  assert.equal((await f.inbox(f.qc)).unread, 0);
  const decision = (
    await f.pool.query(
      `INSERT INTO approval_decisions(qc_review_id,level,decision,decided_by,officer_name)
    VALUES($1,2,'approved',$2,'L2 fixture') RETURNING id`,
      [f.review.id, f.l2.user.id],
    )
  ).rows[0].id;
  await f.pool.query(
    "UPDATE documents SET workflow_status='approved',published_at=now(),published_by=$2 WHERE id=$1",
    [f.doc.id, f.l2.user.id],
  );
  await f.emit(f.l2, 'approval.published', { cycle: 1, decisionId: decision });
  for (const person of [f.op, f.qc, f.l1]) {
    const notice = (await f.inbox(person)).notifications[0];
    assert.equal(notice.action, 'approval.published');
    assert.equal(notice.destination.id, decision);
    assert.equal(notice.destination.label, 'View / download QR');
  }
  assert.equal((await f.inbox(f.otherQc)).unread, 0, 'Do not broadcast closure to uninvolved QC');
  assert.equal((await f.inbox(f.l2)).unread, 1, 'Actor receives no duplicate self-notification');
  await f.pool.query(`INSERT INTO qc_reviews(document_id,cycle,submitted_at) VALUES($1,2,now())`, [
    f.doc.id,
  ]);
  await f.pool.query(
    "UPDATE documents SET workflow_status='qc_waiting',review_cycle=2,published_at=NULL,published_by=NULL WHERE id=$1",
    [f.doc.id],
  );
  await f.emit(f.l2, 'approval.taken_down', {
    target: 'qc',
    reason: 'Recheck fixture',
    toCycle: 2,
  });
  const notices = (await f.inbox(f.op)).notifications;
  assert.equal(notices[0].reason, 'Recheck fixture');
  assert.equal(
    notices.find((n) => n.action === 'approval.published').destination.label,
    'View historical QR',
  );
});

test('keyset paging and bounded mark-all-read do not swallow newer arrivals', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 28; i++) await f.emit(f.qc, 'qc.claimed', { cycle: 1 });
  const page = await f.inbox(f.op);
  assert.equal(page.notifications.length, 25);
  assert.ok(page.next);
  const older = await f.inbox(f.op, `?before=${page.next}`);
  assert.equal(older.notifications.length, 3);
  assert.equal(new Set([...page.notifications, ...older.notifications].map((n) => n.id)).size, 28);
  await f.emit(f.qc, 'qc.returned', { cycle: 1, reason: 'A new arrival' });
  assert.equal(
    (await f.op.request('/api/notifications', { action: 'read-all', through: page.latest })).status,
    200,
  );
  const unread = await f.inbox(f.op, '?filter=unread');
  assert.equal(unread.unread, 1);
  assert.equal(unread.notifications[0].reason, 'A new arrival');
});

test('notification links enforce access; SSE cleanup releases subscribers without database leases per tab', () => {
  const user = { id: 'operator', permissions: ['notifications:read'] };
  assert.equal(notificationDestination({ can_view: false, decision_id: 'old' }, user), null);
  assert.equal(
    notificationDestination(
      { can_view: true, decision_id: 'old', current_confirmation: false },
      user,
    ).label,
    'View historical QR',
  );
  const inbox = staffNotifications({}, {});
  const response = new EventEmitter();
  let ended = 0;
  response.writeHead = () => {};
  response.write = () => true;
  response.end = () => {
    ended++;
    response.emit('close');
  };
  assert.deepEqual(inbox.stream({ method: 'GET' }, response, user), { streaming: true });
  inbox.disconnect();
  inbox.disconnect();
  assert.equal(ended, 1);
});
