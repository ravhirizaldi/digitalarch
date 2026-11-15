import { failure } from '../errors.mjs';

// Idle reservations and queue entries require a live operator; captures never expire.
export function scannerReservations({ now = Date.now, leaseMs = 120000 } = {}) {
  const devices = new Map();
  function queue(key) {
    const entries = (devices.get(key) || []).filter(
      (entry) => entry.jobId || entry.expiresAt > now(),
    );
    devices.set(key, entries);
    return entries;
  }
  const api = {
    status(key, owner) {
      const entries = queue(key);
      const position = entries.findIndex((entry) => entry.owner === owner);
      return {
        position: position < 0 ? null : position,
        held: position === 0,
        waiting: entries.length - (entries.length ? 1 : 0),
        active: !!entries[0]?.jobId,
        recoveryRequired: !!entries[0]?.recovery,
        expiresAt: position < 0 || entries[position].jobId ? null : entries[position].expiresAt,
      };
    },
    heartbeat(owner) {
      for (const key of devices.keys()) {
        const entry = queue(key).find((entry) => entry.owner === owner);
        if (entry) entry.expiresAt = now() + leaseMs;
      }
    },
    reserve(key, owner) {
      for (const other of devices.keys()) {
        if (other !== key && queue(other).some((entry) => entry.owner === owner))
          throw failure(
            'reservation_exists',
            'Release your current scanner or queue position first.',
            409,
          );
      }
      const entries = queue(key);
      if (!entries.some((entry) => entry.owner === owner))
        entries.push({ owner, expiresAt: now() + leaseMs });
      api.heartbeat(owner);
      return api.status(key, owner);
    },
    release(key, owner) {
      const entries = queue(key);
      const entry = entries.find((entry) => entry.owner === owner);
      if (entry?.jobId)
        throw failure(
          'busy',
          'Capture and page reconciliation must finish before releasing this scanner.',
          409,
        );
      devices.set(
        key,
        entries.filter((entry) => entry.owner !== owner),
      );
    },
    begin(key, owner, jobId) {
      const entry = queue(key)[0];
      if (!entry || entry.owner !== owner)
        throw failure(
          'reservation_required',
          'Reserve this scanner and wait for your turn before loading paper and scanning.',
          409,
        );
      if (entry.jobId)
        throw failure('busy', 'This scanner is still capturing or registering pages.', 409);
      entry.jobId = jobId;
    },
    end(key, jobId) {
      const entry = queue(key)[0];
      if (entry?.jobId === jobId) {
        delete entry.jobId;
        entry.expiresAt = now() + leaseMs;
      }
    },
    restore(key, jobId) {
      devices.set(key, [{ owner: null, jobId, recovery: true }]);
    },
  };
  return api;
}
