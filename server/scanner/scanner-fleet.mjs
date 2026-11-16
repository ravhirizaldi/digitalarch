import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { failure } from '../errors.mjs';
import { writeJson } from '../storage.mjs';
import { scannerService } from './scanner-service.mjs';
import { scannerReservations } from './reservations.mjs';

export async function scannerFleet({ base, createReal, dataDir }) {
  const operators = new Map();
  const jobs = new Map();
  const fallback = {
    captureStatus: base.captureStatus,
    cancel: base.cancel,
    job: base.job,
    releaseJob: base.releaseJob,
  };
  const reservations = scannerReservations();
  const directory = path.join(dataDir, 'scanner-active');
  await mkdir(directory, { recursive: true });
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.json')) continue;
    const saved = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
    if (
      !saved ||
      typeof saved.key !== 'string' ||
      !saved.key.startsWith('Wia:') ||
      typeof saved.jobId !== 'string' ||
      !saved.jobId
    )
      throw failure(
        'invalid_recovery_marker',
        'Invalid scanner recovery marker. Verify stopped Windows helpers and recover the marker before starting DigitalArch.',
        500,
      );
    reservations.restore(saved.key, saved.jobId);
  }
  const marker = (key) => `${createHash('sha256').update(key).digest('hex')}.json`;
  const keyFor = (status) =>
    status.mode === 'real' && status.device?.id ? `Wia:${status.device.id}` : null;
  function scope(owner) {
    if (!operators.has(owner))
      operators.set(
        owner,
        (async () => {
          const local = scannerService({
            providers: { simulator: base.providers.simulator, real: createReal() },
            dataDir,
          });
          await local.initialize();
          let reservedKey = null;
          const status = () => {
            const selected = local.status();
            const key = reservedKey || keyFor(selected);
            const reservation = key ? reservations.status(key, owner) : null;
            return {
              ...selected,
              reservation,
              canScan:
                selected.canScan &&
                (!key || (key === keyFor(selected) && reservation.held && !reservation.active)),
              devices: selected.devices?.map((device) => ({
                ...device,
                reservation: reservations.status(`Wia:${device.id}`, owner),
              })),
            };
          };
          let selectionBusy = false;
          const exclusive = async (operation) => {
            if (selectionBusy)
              throw failure('busy', 'Your scanner selection is being checked.', 409);
            selectionBusy = true;
            try {
              return await operation();
            } finally {
              selectionBusy = false;
            }
          };
          function selectionIdle() {
            const key = reservedKey || keyFor(local.status());
            const reservation = key && reservations.status(key, owner);
            if (reservation && reservation.position !== null)
              throw failure(
                'reservation_exists',
                'Release your scanner or queue position before changing selection.',
                409,
              );
            reservedKey = null;
          }
          const api = {
            status,
            pollStatus() {
              reservations.heartbeat(owner);
              return status();
            },
            refresh(selection = {}) {
              return exclusive(async () => {
                if (Object.keys(selection).length) selectionIdle();
                await local.refresh(selection);
                return status();
              });
            },
            setMode(value) {
              return exclusive(async () => {
                selectionIdle();
                await local.setMode(value);
                return status();
              });
            },
            reserve() {
              return exclusive(async () => {
                const key = keyFor(local.status());
                if (!key)
                  throw failure('device_required', 'Choose a detected real scanner first.', 409);
                reservations.reserve(key, owner);
                reservedKey = key;
                return status();
              });
            },
            release() {
              return exclusive(async () => {
                const key = reservedKey || keyFor(local.status());
                if (key) reservations.release(key, owner);
                reservedKey = null;
                return status();
              });
            },
            start(options = {}, beforeStart = async () => {}, sessionId = randomUUID()) {
              return exclusive(async () => {
                const key = keyFor(local.status());
                if (local.status().mode === 'real' && !key)
                  throw failure(
                    'device_required',
                    'Choose and reserve a detected real scanner first.',
                    409,
                  );
                // Claim before asynchronous preflight, retaining exclusivity through database reconciliation.
                if (key) reservations.begin(key, owner, sessionId);
                let tracked;
                try {
                  return await local.start(
                    options,
                    async (job) => {
                      if (key && key !== `Wia:${job.deviceId}`)
                        throw failure('device_changed', 'Reserve the selected device again.', 409);
                      if (key) await writeJson(directory, marker(key), { key, jobId: sessionId });
                      tracked = job.id;
                      jobs.set(job.id, { local, key, sessionId });
                      base.providers.real.scans =
                        local.providers.real.scans || base.providers.real.scans;
                      await beforeStart(job);
                    },
                    sessionId,
                  );
                } catch (error) {
                  if (key) {
                    await unlink(path.join(directory, marker(key))).catch((err) => {
                      if (err.code !== 'ENOENT') throw err;
                    });
                    reservations.end(key, sessionId);
                  }
                  if (tracked) jobs.delete(tracked);
                  throw error;
                }
              });
            },
          };
          return api;
        })(),
      );
    return operators.get(owner);
  }
  return {
    forUser: scope,
    async releaseUser(owner) {
      const selected = operators.get(owner);
      if (selected) await (await selected).release();
    },
    captureStatus(id) {
      return (jobs.get(id)?.local || fallback).captureStatus(id);
    },
    cancel(id) {
      return (jobs.get(id)?.local || fallback).cancel(id);
    },
    job(id) {
      return (jobs.get(id)?.local || fallback).job(id);
    },
    async releaseJob(id) {
      const entry = jobs.get(id);
      if (!entry) return fallback.releaseJob(id);
      if (entry.local.captureStatus(id).jobStatus === 'scanning') return;
      if (entry.key) {
        await unlink(path.join(directory, marker(entry.key)));
        reservations.end(entry.key, entry.sessionId);
      }
      entry.local.releaseJob(id);
      jobs.delete(id);
    },
  };
}
