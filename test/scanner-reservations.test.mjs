import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { createService } from '../server.mjs';
import { scannerReservations } from '../server/scanner/reservations.mjs';
import { fallbackProfile } from '../server/scanner/real-scanner.mjs';

test('per-device FIFO, idempotent joining, cancellation and idle expiry', () => {
  let time = 0;
  const reservations = scannerReservations({ now: () => time, leaseMs: 100 });
  assert.equal(reservations.reserve('a', 'one').held, true);
  assert.equal(reservations.reserve('a', 'two').position, 1);
  assert.equal(reservations.reserve('a', 'two').position, 1);
  assert.equal(reservations.reserve('b', 'three').held, true);
  assert.throws(() => reservations.reserve('b', 'two'), { code: 'reservation_exists' });
  reservations.release('a', 'two');
  assert.equal(reservations.status('a', 'two').position, null);
  reservations.reserve('a', 'two');
  time = 50;
  reservations.heartbeat('two');
  time = 101;
  assert.equal(reservations.status('a', 'two').held, true);
  assert.throws(() => reservations.begin('a', 'one', 'job'), { code: 'reservation_required' });
});

test('capture never expires and release waits for reconciliation; stale completion cannot unlock a later job', () => {
  let time = 0;
  const reservations = scannerReservations({ now: () => time, leaseMs: 100 });
  reservations.reserve('a', 'one');
  reservations.begin('a', 'one', 'job');
  time = 10000;
  assert.equal(reservations.reserve('a', 'two').position, 1);
  assert.throws(() => reservations.release('a', 'one'), { code: 'busy' });
  reservations.end('a', 'wrong');
  assert.equal(reservations.status('a', 'one').active, true);
  reservations.end('a', 'job');
  reservations.release('a', 'one');
  assert.equal(reservations.status('a', 'two').held, true);
  reservations.begin('a', 'two', 'next');
  reservations.end('a', 'job');
  assert.equal(reservations.status('a', 'two').active, true);
});

test('restart quarantine never leases an unresolved device', () => {
  const reservations = scannerReservations({ now: () => Number.MAX_SAFE_INTEGER });
  reservations.restore('a', 'unknown-process');
  assert.equal(reservations.reserve('a', 'operator').position, 1);
  assert.equal(reservations.status('a', 'operator').recoveryRequired, true);
  assert.throws(() => reservations.begin('a', 'operator', 'new'), { code: 'reservation_required' });
});

async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await sleep(10);
  }
  throw new Error('Capture did not settle');
}

test('malformed recovery markers fail closed instead of making an unresolved device available', async (t) => {
  const dataDir = await mkdtemp('/tmp/opencode/digitalarch-fleet-invalid-');
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await mkdir(path.join(dataDir, 'scanner-active'));
  await writeFile(
    path.join(dataDir, 'scanner-active', 'invalid.json'),
    JSON.stringify({ key: 'Wia:a' }),
  );
  await assert.rejects(createService({ dataDir }), { code: 'invalid_recovery_marker' });
});

test('status polling renews reservations without inspecting Windows', async (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  let inspections = 0;
  const dataDir = await mkdtemp('/tmp/opencode/digitalarch-poll-');
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = await createService({
    dataDir,
    prepare: async () => ({
      inspect: async () => {
        inspections++;
        return {
          profiles: [],
          devices: [{ id: 'a', name: 'Scanner', driver: 'Wia' }],
          profileId: fallbackProfile.id,
          probe: { success: true, state: 'device_detected', canScan: true },
        };
      },
    }),
  });
  const operator = await service.forUser('operator');
  await operator.setMode('real');
  await operator.reserve();
  now = 90000;
  assert.equal(operator.pollStatus().reservation.held, true);
  now = 180000;
  assert.equal(operator.pollStatus().reservation.held, true);
  assert.equal(operator.status().checking, false);
  assert.equal(inspections, 1);
});

test('operator selections, capture cancellation and FIFO queues are independent across devices', async (t) => {
  const dataDir = await mkdtemp('/tmp/opencode/digitalarch-fleet-');
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const scans = path.join(dataDir, 'real');
  await mkdir(scans);
  const devices = ['a', 'b'].map((id) => ({ id, name: `Scanner ${id}`, driver: 'Wia' }));
  const pending = new Map();
  let preparations = 0;
  const options = {
    dataDir,
    prepare: async () => {
      preparations++;
      return {
        scans,
        inspect: async (_profile, deviceId, inventoryOnly) => {
          assert.equal(inventoryOnly, true, 'Fleet discovery must not probe occupied hardware');
          return {
            profiles: [],
            devices,
            profileId: fallbackProfile.id,
            probe: { success: true, state: 'device_detected', canScan: !!deviceId },
          };
        },
        scan: async (id, { signal, deviceId }) =>
          new Promise((resolve, reject) => {
            pending.set(id, { resolve, deviceId });
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      };
    },
  };
  const service = await createService(options);
  const [one, two, three] = await Promise.all(
    ['one', 'two', 'three'].map((id) => service.forUser(id)),
  );
  for (const [operator, deviceId] of [
    [one, 'a'],
    [two, 'a'],
    [three, 'b'],
  ]) {
    await operator.setMode('real');
    await operator.refresh({ profileId: fallbackProfile.id, deviceId });
  }
  assert.equal(preparations, 1, 'Helper deployment is single-flight');
  await one.reserve();
  await two.reserve();
  await three.reserve();
  assert.equal(two.status().reservation.position, 1);
  await assert.rejects(
    two.start({}, async () => {}, randomUUID()),
    { code: 'reservation_required' },
  );
  const a = await one.start({}, async () => {}, randomUUID());
  const b = await three.start({}, async () => {}, randomUUID());
  await until(() => pending.size === 2);
  assert.equal(pending.get(a.id).deviceId, 'a');
  assert.equal(pending.get(b.id).deviceId, 'b');
  service.cancel(a.id);
  await until(() => service.captureStatus(a.id).jobStatus === 'cancelled');
  assert.equal(service.captureStatus(b.id).jobStatus, 'scanning');
  assert.equal(
    one.status().reservation.active,
    true,
    'Keep device until saved pages are reconciled',
  );
  await assert.rejects(one.release(), { code: 'busy' });
  await service.releaseJob(a.id);
  await one.release();
  assert.equal(two.status().reservation.held, true);
  assert.equal(two.status().canScan, true);
  const restarted = await createService(options);
  const observer = await restarted.forUser('observer');
  await observer.setMode('real');
  await observer.refresh({ profileId: fallbackProfile.id, deviceId: 'b' });
  assert.equal(observer.status().reservation.recoveryRequired, true);
  assert.equal(observer.status().canScan, false);
  pending.get(b.id).resolve();
  await until(() => service.captureStatus(b.id).jobStatus === 'complete');
  await service.releaseJob(b.id);
});
