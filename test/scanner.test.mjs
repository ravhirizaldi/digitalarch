import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { createService } from '../server.mjs';
import { realScanner, fallbackProfile, matchDevice } from '../server/scanner/real-scanner.mjs';
import { failure } from '../server/errors.mjs';

async function setup(t, options = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'digitalarch-modes-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = await createService({
    dataDir,
    prepare: async () => {
      throw failure('helper_unavailable', 'Windows unavailable.');
    },
    ...options,
  });
  return { service, dataDir };
}
async function until(fn) {
  for (let i = 0; i < 300; i++) {
    const value = await fn();
    if (value) return value;
    await sleep(10);
  }
  throw new Error('Timed out waiting for test condition');
}
async function finish(service, id) {
  return until(async () => {
    const job = await service.job(id);
    return job.status !== 'scanning' && job.completedAt ? job : null;
  });
}
const brother = { id: 'actual-discovered-id', name: 'Brother ADS-2400N', driver: 'Wia' };
function fakeBridge(overrides = {}) {
  return {
    scans: null,
    profiles: async () => ({ profiles: [], warnings: ['No native profiles.'] }),
    devices: async () => ({ devices: [brother] }),
    probe: async () => ({
      state: 'capabilities_verified',
      canScan: true,
      message: 'Capabilities checked; paper not checked.',
    }),
    scan: async () => {},
    ...overrides,
  };
}

test('simulator initializes and scans without ever preparing a Windows helper', async (t) => {
  let calls = 0;
  const { service } = await setup(t, {
    prepare: async () => {
      calls++;
      throw new Error('Must not be called');
    },
  });
  assert.equal(service.status().mode, 'simulator');
  assert.equal(service.status().state, 'simulator_ready');
  await service.refresh();
  const start = await service.start({ scenario: 'single', pageDelay: 0 });
  const job = await finish(service, start.id);
  assert.equal(job.status, 'complete');
  assert.equal(job.pages.length, 1);
  assert.deepEqual(
    Object.keys(job.pages[0]).sort(),
    ['filename', 'id', 'jobId', 'mimeType', 'pageNumber', 'provider'].sort(),
  );
  assert.equal(job.pages[0].mimeType, 'image/png');
  assert.equal(job.pages[0].provider, 'simulator');
  assert.equal(job.deviceId, 'virtual');
  assert.equal(job.profileId, 'simulator');
  assert.ok(job.completedAt >= job.startedAt);
  assert.equal(calls, 0);
});

test('multi-page and duplex scans preserve deterministic source order and unique jobs', async (t) => {
  const { service } = await setup(t);
  const ids = [];
  for (const [scenario, count, folder] of [
    ['multi', 3, 'basic'],
    ['duplex', 4, 'duplex'],
  ]) {
    const start = await service.start({ scenario, pageDelay: 0 });
    ids.push(start.id);
    const job = await finish(service, start.id);
    assert.equal(job.pages.length, count);
    assert.deepEqual(
      job.pages.map((p) => p.pageNumber),
      Array.from({ length: count }, (_, i) => i + 1),
    );
    const { readdir } = await import('node:fs/promises');
    const fixtures = (await readdir(`fixtures/${folder}`)).filter((f) => f.endsWith('.png')).sort();
    for (let i = 0; i < count; i++)
      assert.deepEqual(
        await readFile(path.join(service.providers.simulator.scans, job.pages[i].filename)),
        await readFile(`fixtures/${folder}/${fixtures[i]}`),
      );
  }
  assert.notEqual(ids[0], ids[1]);
  assert.equal(
    (await service.job(ids[0])).pages.length + (await service.job(ids[1])).pages.length,
    7,
  );
});

test('pages become available progressively and mode/concurrent scan changes are blocked', async (t) => {
  const { service } = await setup(t);
  const start = await service.start({ scenario: 'multi', pageDelay: 60 });
  assert.equal((await service.job(start.id)).pages.length, 0);
  await assert.rejects(service.setMode('real'), { code: 'busy' });
  await assert.rejects(service.refresh(), { code: 'busy' });
  await assert.rejects(service.start(), { code: 'busy' });
  const first = await until(async () => {
    const job = await service.job(start.id);
    return job.pages.length === 1 ? job : null;
  });
  assert.equal(first.status, 'scanning');
  assert.equal(first.totalPages, 3);
  assert.equal((await finish(service, start.id)).pages.length, 3);
});

test('blank and faint/dirty/rotated pages are retained; controlled failures retain partial pages', async (t) => {
  const { service } = await setup(t);
  for (const [scenario, code, pages] of [
    ['blank', null, 4],
    ['empty', 'empty_feeder', 0],
    ['error', 'driver_error', 0],
    ['jam', 'paper_jam', 2],
  ]) {
    const job = await finish(service, (await service.start({ scenario, pageDelay: 0 })).id);
    assert.equal(job.pages.length, pages);
    assert.equal(job.errorCode, code);
    assert.equal(job.status, code ? 'error' : 'complete');
  }
});

test('simulator rejects arbitrary paths, unsupported options, bad delays, and fixture symlinks', async (t) => {
  const { service, dataDir } = await setup(t);
  for (const options of [
    { scenario: '../../private' },
    { fixtureDir: '/etc' },
    { pageDelay: -1 },
    { pageDelay: 10001 },
    { pageDelay: '1' },
    { pageDelay: 1.5 },
  ])
    await assert.rejects(service.start(options), (error) => error.statusCode === 400);
  const directory = path.join(dataDir, 'external-fixtures');
  await mkdir(directory);
  await symlink(path.resolve('fixtures/basic/page-001.png'), path.join(directory, 'secret.png'));
  const custom = await createService({
    dataDir: path.join(dataDir, 'custom'),
    customFixtures: directory,
  });
  const job = await finish(custom, (await custom.start({ pageDelay: 0 })).id);
  assert.equal(job.errorCode, 'fixtures_unavailable');
  assert.equal(job.pages.length, 0);
  await writeFile(
    path.join(directory, 'sample.png'),
    await readFile('fixtures/basic/page-001.png'),
  );
  const good = await finish(custom, (await custom.start({ pageDelay: 0 })).id);
  assert.equal(good.pages.length, 1);
});

test('mode selection is authoritative; unavailable hardware never falls back to simulation', async (t) => {
  const { service } = await setup(t);
  await service.setMode('real');
  assert.equal(service.status().mode, 'real');
  assert.equal(service.status().state, 'helper_unavailable');
  await assert.rejects(service.start(), { code: 'helper_unavailable' });
  assert.equal(service.status().canScan, false);
  await service.setMode('simulator');
  assert.equal(service.status().canScan, true);
  await assert.rejects(service.setMode('twain'), { code: 'invalid_mode' });
});

test('hardware matching prefers exact profile ID and never uses an unrelated first device', () => {
  const unrelated = { id: 'other', name: 'Other scanner', driver: 'Wia' };
  assert.equal(matchDevice(fallbackProfile, []).state, 'device_not_found');
  assert.equal(matchDevice(fallbackProfile, [unrelated]).state, 'device_not_found');
  assert.equal(matchDevice(fallbackProfile, [unrelated, brother]).device.id, brother.id);
  assert.equal(
    matchDevice(fallbackProfile, [brother, { ...brother, id: 'second' }]).state,
    'ambiguous_device',
  );
  assert.equal(
    matchDevice({ ...fallbackProfile, deviceId: 'second' }, [brother, { ...brother, id: 'second' }])
      .device.id,
    'second',
  );
  assert.equal(
    matchDevice(fallbackProfile, [brother, unrelated], 'other').state,
    'profile_mismatch',
  );
  assert.equal(
    matchDevice(fallbackProfile, [brother, { ...brother, id: 'second' }], 'second').device.id,
    'second',
  );
});

test('real discovery, profile matching, disappearance, and refresh recovery use mocked helper evidence', async () => {
  let available = [brother];
  let scans = 0;
  const native = {
    ...fallbackProfile,
    id: 'naps2-test',
    name: 'Office',
    source: 'naps2-desktop',
    deviceId: brother.id,
  };
  const provider = realScanner({
    prepare: async () =>
      fakeBridge({
        devices: async () => ({ devices: available }),
        profiles: async () => ({ profiles: [native], warnings: [] }),
        scan: async () => {
          scans++;
        },
      }),
  });
  let status = await provider.inspect();
  assert.equal(status.state, 'capabilities_verified');
  assert.equal(status.profiles.length, 2);
  assert.equal(status.profileId, 'digitalarch-default');
  assert.equal(status.profiles[1].deviceMatch.matched, true);
  assert.equal(scans, 0);
  await provider.inspect({ profileId: native.id });
  assert.equal(provider.snapshot().profileId, native.id);
  available = [];
  assert.equal((await provider.inspect()).state, 'device_not_found');
  assert.equal(provider.snapshot().canScan, false);
  available = [brother];
  assert.equal((await provider.inspect()).canScan, true);
  await provider.scan({ id: 'scan-test' });
  assert.equal(scans, 1);
  assert.ok(provider.snapshot().lastSuccessfulScanAt);
});

test('combined real inspection uses one helper call and rechecks before scanning', async () => {
  let calls = 0;
  let scans = 0;
  let available = true;
  const provider = realScanner({
    prepare: async () => ({
      scans: null,
      inspect: async (profileId, deviceId) => {
        calls++;
        assert.equal(profileId, fallbackProfile.id);
        assert.equal(deviceId, null);
        return {
          profiles: [],
          warnings: [],
          devices: available ? [brother] : [],
          probe: available
            ? { success: true, state: 'capabilities_verified', canScan: true, message: 'Checked' }
            : { success: false, error: { code: 'device_not_found', message: 'Disconnected' } },
        };
      },
      scan: async () => {
        scans++;
      },
    }),
  });
  assert.equal((await provider.inspect()).canScan, true);
  assert.equal(calls, 1, 'No separate profiles/devices/probe launches');
  assert.equal(provider.snapshot().devices.length, 1);
  available = false;
  await assert.rejects(provider.scan({ id: 'must-not-scan' }), { code: 'device_not_found' });
  assert.equal(calls, 2);
  assert.equal(scans, 0);
});

test('combined inspection retains inventory and controlled capability failures', async () => {
  const native = {
    ...fallbackProfile,
    id: 'naps2-unsupported',
    source: 'naps2-desktop',
    compatible: false,
  };
  const provider = realScanner({
    prepare: async () => ({
      scans: null,
      inspect: async () => ({
        profiles: [native],
        warnings: ['Read-only native settings'],
        devices: [brother],
        probe: {
          success: false,
          error: { code: 'capabilities_unavailable', message: 'Cannot verify capabilities' },
        },
      }),
    }),
  });
  const status = await provider.inspect();
  assert.equal(status.canScan, false);
  assert.equal(status.state, 'device_detected');
  assert.equal(status.devices.length, 1);
  assert.equal(status.profiles.length, 2, 'Profiles are not duplicate physical scanners');
  assert.equal(status.profileWarnings[0], 'Read-only native settings');
  assert.equal((await provider.inspect({ profileId: native.id })).state, 'unsupported_profile');
});

test('driver/helper/capability failures and unsupported native settings are explicit', async () => {
  for (const code of ['driver_error', 'helper_unavailable', 'timeout']) {
    const provider = realScanner({
      prepare: async () =>
        fakeBridge({
          devices: async () => {
            throw failure(code, 'Inspection failed.');
          },
        }),
    });
    const status = await provider.inspect();
    assert.equal(status.state, code);
    assert.equal(status.canScan, false);
  }
  const provider = realScanner({
    prepare: async () =>
      fakeBridge({
        probe: async () => {
          throw failure('capabilities_unavailable', 'Cannot verify capabilities.');
        },
      }),
  });
  assert.equal((await provider.inspect()).state, 'device_detected');
  assert.equal(provider.snapshot().canScan, false);
  const unsupported = {
    ...fallbackProfile,
    id: 'naps2-unsupported',
    source: 'naps2-desktop',
    compatible: false,
    limitations: ['AutoCrop is not applied.'],
  };
  const native = realScanner({
    prepare: async () =>
      fakeBridge({
        profiles: async () => ({
          profiles: [unsupported],
          warnings: ['Malformed profiles ignored.'],
        }),
      }),
  });
  const status = await native.inspect({ profileId: unsupported.id });
  assert.equal(status.state, 'unsupported_profile');
  assert.equal(status.profiles[0].source, 'digitalarch');
  assert.equal(status.profiles[1].limitations[0], 'AutoCrop is not applied.');
});

test('real scan failure preserves captured pages, records failure and supports explicit refresh/retry', async (t) => {
  const { service, dataDir } = await setup(t);
  const realDir = path.join(dataDir, 'real-scans');
  await mkdir(realDir);
  const provider = realScanner({
    prepare: async () =>
      fakeBridge({
        scans: realDir,
        scan: async (id) => {
          await writeFile(
            path.join(realDir, `${id}-001.png`),
            await readFile('fixtures/basic/page-001.png'),
          );
          throw failure('paper_jam', 'Paper jam; saved page retained.');
        },
      }),
  });
  service.providers.real = provider;
  await service.setMode('real');
  const job = await finish(service, (await service.start()).id);
  assert.equal(job.status, 'error');
  assert.equal(job.pages.length, 1);
  assert.equal(job.provider, 'real');
  assert.equal(service.status().state, 'scan_failed');
  await assert.rejects(service.start(), { code: 'scan_failed' });
  await service.refresh();
  assert.equal(service.status().canScan, true);
  await service.setMode('simulator');
  assert.equal((await service.job(job.id)).provider, 'real');
});

test('provider output and trusted Windows storage configuration persist across restarts', async (t) => {
  const { service, dataDir } = await setup(t);
  const job = await finish(service, (await service.start({ scenario: 'single', pageDelay: 0 })).id);
  const original = await readFile(
    path.join(service.providers.simulator.scans, job.pages[0].filename),
  );
  await createService({ dataDir });
  assert.deepEqual(
    await readFile(path.join(service.providers.simulator.scans, job.pages[0].filename)),
    original,
  );
  const real = path.join(dataDir, 'existing-real');
  await mkdir(real);
  await writeFile(path.join(real, 'scan-123-existing-001.png'), 'preserve-me');
  await writeFile(path.join(dataDir, 'storage.json'), JSON.stringify({ real }));
  const restored = await createService({ dataDir });
  assert.equal(restored.providers.real.scans, real);
  assert.equal(await readFile(path.join(real, 'scan-123-existing-001.png'), 'utf8'), 'preserve-me');
});

test('simulator refuses existing output and does not expose filesystem paths in failures', async (t) => {
  const { service, dataDir } = await setup(t);
  const provider = service.providers.simulator;
  const job = { id: 'scan-999-existing' };
  await provider.scan(job, { scenario: 'single', pageDelay: 0 });
  const original = await readFile(path.join(provider.scans, `${job.id}-001.png`));
  await assert.rejects(provider.scan(job, { scenario: 'single', pageDelay: 0 }), {
    code: 'EEXIST',
  });
  assert.deepEqual(await readFile(path.join(provider.scans, `${job.id}-001.png`)), original);
  const missing = await createService({
    dataDir: path.join(dataDir, 'other'),
    customFixtures: path.join(dataDir, 'private-missing-fixtures'),
  });
  const failed = await finish(missing, (await missing.start({ pageDelay: 0 })).id);
  assert.equal(failed.status, 'error');
  assert.equal(failed.error.includes(dataDir), false);
});

test('failed helper preparation can recover on refresh without silently changing modes', async (t) => {
  let count = 0;
  const { service } = await setup(t, {
    prepare: async () => {
      if (++count === 1) throw failure('helper_unavailable', 'Runtime missing.');
      return fakeBridge();
    },
  });
  await service.setMode('real');
  assert.equal(service.status().helperAvailable, false);
  assert.equal(service.status().mode, 'real');
  await service.refresh();
  assert.equal(service.status().canScan, true);
  assert.equal(service.status().mode, 'real');
});
