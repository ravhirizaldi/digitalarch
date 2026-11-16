import { failure, publicError } from '../errors.mjs';

export const fallbackProfile = {
  id: 'digitalarch-default',
  name: 'WIA feeder (application defaults)',
  source: 'digitalarch',
  driver: 'Wia',
  deviceName: '',
  deviceId: null,
  compatible: true,
  revision: '1',
  limitations: [],
  settings: {
    paperSource: 'Feeder',
    pageSize: 'Letter',
    dpi: 300,
    colorMode: 'Color',
    pageAlign: 'Right',
  },
};

export function matchDevice(profile, devices, selectedId) {
  const available = devices.filter((d) => d.driver === profile.driver);
  const generic = profile.id === fallbackProfile.id;
  const exact = available.find((d) => profile.deviceId && d.id === profile.deviceId);
  if (selectedId) {
    const device = available.find(
      (d) =>
        d.id === selectedId &&
        (generic || d.id === profile.deviceId || (!exact && d.name === profile.deviceName)),
    );
    return { device, state: device ? 'device_detected' : 'profile_mismatch' };
  }
  const matches = generic
    ? available
    : exact
      ? [exact]
      : available.filter((d) => d.name === profile.deviceName);
  return {
    device: matches.length === 1 ? matches[0] : null,
    state:
      matches.length > 1
        ? 'ambiguous_device'
        : matches.length
          ? 'device_detected'
          : 'device_not_found',
  };
}

export function realScanner({ prepare, inventoryOnly = false }) {
  let bridge;
  let profiles = [fallbackProfile];
  let devices = [];
  let profileId = null;
  let deviceId = null;
  let lastSuccessfulScanAt = null;
  let inventoryChanges = [];
  let inventoryChangedAt = null;
  let status = {
    state: 'not_configured',
    canScan: false,
    helperAvailable: false,
    message: 'Refresh to inspect Windows WIA. No scan will be started.',
  };
  const provider = {
    scans: null,
    snapshot() {
      return {
        ...status,
        devices,
        profiles,
        profileId,
        selectedDeviceId: deviceId,
        lastSuccessfulScanAt,
        inventoryChanges,
        inventoryChangedAt,
      };
    },
    async inspect(selection = {}) {
      profileId = selection.profileId !== undefined ? selection.profileId : profileId;
      deviceId = selection.deviceId !== undefined ? selection.deviceId : deviceId;
      status = { ...status, state: 'checking', canScan: false, message: 'Checking Windows WIA…' };
      try {
        bridge ||= await prepare();
        provider.scans = bridge.scans;
        const inspection = bridge.inspect
          ? await bridge.inspect(profileId, deviceId, inventoryOnly)
          : null;
        const native = inspection || (await bridge.profiles());
        const result = inspection || (await bridge.devices());
        const oldProfiles = profiles;
        const oldDevices = devices;
        profiles = [fallbackProfile, ...native.profiles];
        devices = result.devices;
        const changes = [];
        for (const [kind, before, after] of [
          ['Profile', oldProfiles, profiles],
          ['Device', oldDevices, devices],
        ]) {
          for (const item of after) {
            const old = before.find((previous) => previous.id === item.id);
            if (!old) changes.push(`${kind} added: ${item.name}`);
            else if (kind === 'Profile' && old.revision !== item.revision) {
              const values = (profile) => ({
                ...profile.settings,
                driver: profile.driver,
                deviceId: profile.deviceId,
                deviceName: profile.deviceName,
                isDefault: !!profile.isDefault,
                compatible: profile.compatible,
                limitations: profile.limitations?.join('; '),
              });
              const beforeValues = values(old);
              const differences = Object.entries(values(item))
                .filter(([key, value]) => value !== beforeValues[key])
                .map(
                  ([key, value]) => `${key}: ${beforeValues[key] ?? 'none'} → ${value ?? 'none'}`,
                );
              changes.push(
                `Profile changed: ${item.name} · ${differences.join(' · ') || 'Native definition updated'}`,
              );
            } else if (kind === 'Device' && old.name !== item.name)
              changes.push(`Device changed: ${old.name} → ${item.name}`);
          }
          for (const item of before)
            if (!after.some((current) => current.id === item.id))
              changes.push(`${kind} removed: ${item.name}`);
        }
        if (changes.length) {
          inventoryChanges = changes;
          inventoryChangedAt = new Date().toISOString();
        }
        if (profileId === null) {
          if (inspection && Object.hasOwn(inspection, 'profileId'))
            profileId = inspection.profileId;
          else {
            const defaults = native.profiles.filter((profile) => profile.isDefault);
            const matching = native.profiles.filter(
              (profile) => profile.compatible && matchDevice(profile, devices).device,
            );
            profileId = native.incomplete
              ? null
              : defaults.length === 1
                ? defaults[0].id
                : defaults.length > 1
                  ? null
                  : matching.length === 1
                    ? matching[0].id
                    : native.profiles.length === 0
                      ? fallbackProfile.id
                      : native.profiles.length === 1
                        ? native.profiles[0].id
                        : null;
          }
        }
        profiles = profiles.map((p) => ({
          ...p,
          deviceMatch: (() => {
            const match = matchDevice(p, devices);
            return { matched: !!match.device, status: match.state };
          })(),
        }));
        const profile = profiles.find((p) => p.id === profileId);
        if (!profile) {
          status = {
            state: profileId
              ? 'invalid_profile'
              : inspection?.probe?.error?.code || 'profile_required',
            canScan: false,
            helperAvailable: true,
            profileWarnings: native.warnings || [],
            profileFiles: native.profileFiles || [],
            message:
              inspection?.probe?.error?.message ||
              'Select an available profile. A removed, renamed, unreadable or ambiguous profile will not be replaced silently.',
            lastCheckedAt: new Date().toISOString(),
          };
          return provider.snapshot();
        }
        const match = matchDevice(profile, devices, deviceId);
        status = {
          state: match.state,
          device: match.device || null,
          canScan: false,
          helperAvailable: true,
          profileWarnings: native.warnings || [],
          profileFiles: native.profileFiles || [],
          message: 'The configured scanner is not currently available.',
        };
        if (!profile.compatible) {
          status.state = 'unsupported_profile';
          status.message =
            'This native profile contains unsupported settings. Review its limitations in Scanner settings and select a compatible profile.';
        } else if (match.state === 'ambiguous_device') {
          status.message = 'Multiple matching scanners were discovered. Select an explicit device.';
        } else if (match.state === 'profile_mismatch') {
          status.message =
            'The selected device does not match this profile. Select a matching device.';
        } else if (match.device) {
          try {
            const probe = inspection?.probe || (await bridge.probe(profileId, match.device.id));
            if (probe.success === false) throw failure(probe.error.code, probe.error.message);
            status.state = probe.state;
            status.canScan = probe.canScan;
            status.capabilities = probe.capabilities;
            status.message = probe.message;
          } catch (error) {
            status.state =
              error.code === 'capabilities_unavailable'
                ? 'device_detected'
                : error.code || 'driver_error';
            status.message = error.message;
          }
        } else if (inspection?.probe?.success === false) {
          status.state = inspection.probe.error.code;
          status.message = inspection.probe.error.message;
        }
      } catch (error) {
        status = {
          state: error.statusCode ? error.code : 'helper_unavailable',
          canScan: false,
          helperAvailable: !!bridge && error.code !== 'helper_unavailable',
          message: error.statusCode
            ? publicError(error).message
            : 'Windows scanner helper unavailable. Simulation remains available.',
        };
        devices = [];
        profiles = profiles.map((p) => ({
          ...p,
          deviceMatch: { matched: false, status: status.state },
        }));
        if (status.state === 'helper_unavailable') bridge = null;
      }
      status.lastCheckedAt = new Date().toISOString();
      return provider.snapshot();
    },
    validate(options) {
      if (Object.keys(options).length)
        throw failure(
          'invalid_options',
          'Select the device and profile before starting a real scan.',
        );
      if (!status.canScan) throw failure(status.state, status.message, 409);
    },
    async scan(job, _options, signal) {
      signal?.throwIfAborted();
      // Recheck at scan time: discovery is not a guarantee that the device stayed available.
      const expectedProfile = job.profileId || profileId;
      const expectedRevision =
        job.profileRevision || profiles.find((profile) => profile.id === expectedProfile)?.revision;
      await provider.inspect({ profileId: expectedProfile, deviceId: job.deviceId || deviceId });
      signal?.throwIfAborted();
      if (!status.canScan) throw failure(status.state, status.message, 409);
      if (expectedRevision !== profiles.find((profile) => profile.id === profileId)?.revision)
        throw failure(
          'profile_changed',
          'The scanner profile changed. Review the updated settings before scanning.',
          409,
        );
      job.deviceId = status.device.id;
      job.profileId = profileId;
      try {
        await bridge.scan(job.id, {
          profileId,
          deviceId: status.device.id,
          profileRevision: expectedRevision,
          signal,
        });
        lastSuccessfulScanAt = new Date().toISOString();
      } catch (error) {
        status = { ...status, state: 'scan_failed', canScan: false, message: error.message };
        throw error;
      }
    },
  };
  return provider;
}
