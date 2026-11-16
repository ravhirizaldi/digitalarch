import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { failure, publicError } from '../errors.mjs';
import { jobName, listPages, writeJson } from '../storage.mjs';

export function scannerService({ providers, dataDir, initialMode = 'simulator' }) {
  let mode = initialMode;
  let checking = false;
  let current = null;
  let captureController = null;
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
      if (mode === 'real') {
        const previous = api.status();
        const revision = previous.profiles?.find(
          (profile) => profile.id === previous.profileId,
        )?.revision;
        await api.refresh();
        const selected = api.status();
        provider.validate?.(normalized);
        if (previous.device?.id !== selected.device?.id)
          throw failure(
            'device_changed',
            'The selected scanner changed. Review the detected device before starting capture.',
            409,
          );
        if (
          revision !==
          selected.profiles?.find((profile) => profile.id === selected.profileId)?.revision
        )
          throw failure(
            'profile_changed',
            'The profile changed. Review its updated settings before starting capture.',
            409,
          );
      }
      const selected = api.status();
      const job = {
        id: `scan-${Date.now()}-${sessionId}`,
        provider: mode,
        deviceId: selected.device?.id || null,
        profileId: selected.profileId || null,
        profileRevision:
          selected.profiles?.find((profile) => profile.id === selected.profileId)?.revision || null,
        status: 'scanning',
        error: null,
        errorCode: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        options: normalized,
        totalPages: null,
      };
      current = job;
      const controller = new AbortController();
      captureController = controller;
      jobs.set(job.id, job);
      try {
        // The application commits its database session before capture can consume paper.
        if (beforeStart) await beforeStart({ ...job });
      } catch (error) {
        current = null;
        captureController = null;
        jobs.delete(job.id);
        throw error;
      }
      const response = { ...job };
      const cancelled = () => {
        job.status = 'cancelled';
        job.errorCode = 'scan_cancelled';
        job.error =
          'Scan cancelled. Captured pages are retained. Check the scanner before starting another session.';
      };
      Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return provider.scan(job, normalized, controller.signal);
        })
        .then(
          () => {
            if (controller.signal.aborted) cancelled();
            else job.status = 'complete';
          },
          (error) => {
            if (error.code === 'capture_stop_unconfirmed') {
              // Unknown process termination must not unlock capture or stop file reconciliation.
              job.cancelRequested = true;
              job.errorCode = error.code;
              job.error = error.message;
              return;
            }
            if (controller.signal.aborted) {
              cancelled();
              return;
            }
            if (!error.statusCode) console.error('Scan job failed:', error);
            const problem = publicError(error);
            job.status = 'error';
            job.error = problem.message;
            job.errorCode = problem.code;
          },
        )
        .then(() => {
          if (job.status === 'scanning') return;
          job.completedAt = new Date().toISOString();
          if (current === job) captureController = null;
        });
      return response;
    },
    captureStatus(id) {
      const job = jobs.get(id);
      return {
        jobStatus: job?.status || 'unknown',
        cancelRequested: !!job?.cancelRequested,
        stopError: job?.errorCode === 'capture_stop_unconfirmed' ? job.error : null,
      };
    },
    cancel(id) {
      if (!jobName.test(id) || !jobs.has(id))
        throw failure(
          'capture_unavailable',
          'Capture state is being reconciled. Wait for recovery before retrying.',
          409,
        );
      const job = jobs.get(id);
      if (job.status !== 'scanning' || job.cancelRequested) return false;
      if (current !== job || !captureController)
        throw failure(
          'capture_unavailable',
          'The capture process could not be identified safely.',
          409,
        );
      job.cancelRequested = true;
      captureController.abort();
      return true;
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
