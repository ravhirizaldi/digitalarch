import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { failure, publicError } from '../errors.mjs';
import { jobName, listPages, writeJson } from '../storage.mjs';

export function scannerService({ providers, dataDir, initialMode = 'simulator' }) {
  let mode = initialMode;
  let checking = false;
  let current = null;
  const jobs = new Map();
  const snapshots = {};
  const idle = () => {
    if (current?.status === 'scanning' || checking)
      throw failure('busy', 'A scanner operation is already running.', 409);
  };
  const api = {
    providers,
    async initialize() {
      snapshots.simulator = providers.simulator ? await providers.simulator.inspect() : null;
      snapshots.real = providers.real?.snapshot?.() || null;
      if (dataDir) {
        // Remember only the local storage location, never a universal device identifier.
        try {
          const saved = JSON.parse(await readFile(path.join(dataDir, 'storage.json'), 'utf8'));
          if (typeof saved.real === 'string' && path.isAbsolute(saved.real))
            providers.real.scans = saved.real;
        } catch (error) {
          if (error.code !== 'ENOENT') console.error('Could not restore real scan location.');
        }
      }
    },
    status() {
      const selected = providers[mode];
      const snapshot = selected.snapshot?.() || snapshots[mode] || {};
      return {
        ...snapshot,
        mode,
        busy: current?.status === 'scanning',
        checking,
        state: checking ? 'checking' : snapshot.state,
        canScan: !!snapshot.canScan && !checking && current?.status !== 'scanning',
      };
    },
    async refresh(selection = {}) {
      idle();
      if (mode === 'simulator' && Object.keys(selection).length)
        throw failure(
          'invalid_options',
          'Device and profile selection are only available in Real Hardware mode.',
        );
      checking = true;
      try {
        snapshots[mode] = await providers[mode].inspect(selection);
        if (mode === 'real' && dataDir && providers.real.scans)
          await writeJson(dataDir, 'storage.json', { real: providers.real.scans });
        return snapshots[mode];
      } finally {
        checking = false;
      }
    },
    async setMode(value) {
      idle();
      if (!['real', 'simulator'].includes(value) || !providers[value])
        throw failure('invalid_mode', 'Choose simulator or real.');
      mode = value;
      await api.refresh();
      return api.status();
    },
    async start(options = {}, beforeStart, sessionId = randomUUID()) {
      idle();
      const provider = providers[mode];
      const normalized =
        mode === 'simulator' ? { scenario: 'multi', pageDelay: 500, ...options } : options;
      provider.validate?.(normalized);
      const selected = api.status();
      const job = {
        id: `scan-${Date.now()}-${sessionId}`,
        provider: mode,
        deviceId: selected.device?.id || null,
        profileId: selected.profileId || null,
        status: 'scanning',
        error: null,
        errorCode: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        options: normalized,
        totalPages: null,
      };
      current = job;
      jobs.set(job.id, job);
      try {
        // The application commits its database session before capture can consume paper.
        if (beforeStart) await beforeStart({ ...job });
      } catch (error) {
        current = null;
        jobs.delete(job.id);
        throw error;
      }
      const response = { ...job };
      Promise.resolve()
        .then(() => provider.scan(job, normalized))
        .then(
          () => {
            job.status = 'complete';
          },
          (error) => {
            if (!error.statusCode) console.error('Scan job failed:', error);
            const problem = publicError(error);
            job.status = 'error';
            job.error = problem.message;
            job.errorCode = problem.code;
          },
        )
        .then(() => {
          job.completedAt = new Date().toISOString();
        });
      return response;
    },
    async job(id) {
      if (!jobName.test(id) || !jobs.has(id))
        throw failure('not_found', 'Scan job not found.', 404);
      const job = jobs.get(id);
      const pages = await listPages(providers[job.provider].scans, job.provider, job.id);
      return { ...job, jobId: job.id, pages, capturedPages: pages.length };
    },
    releaseJob(id) {
      if (jobs.get(id)?.status !== 'scanning') jobs.delete(id);
    },
  };
  return api;
}
