import { failure, publicError } from '../errors.mjs';

export const fallbackProfile = {
  id: 'digitalarch-default',
  name: 'Brother ADS-2400N (Default)',
  source: 'digitalarch',
  driver: 'Wia',
  deviceName: 'Brother ADS-2400N',
  deviceId: null,
  compatible: true,
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
  if (selectedId) {
    const device = available.find(
      (d) => d.id === selectedId && (d.id === profile.deviceId || d.name === profile.deviceName),
    );
    return { device, state: device ? 'device_detected' : 'profile_mismatch' };
  }
  const exact = available.find((d) => profile.deviceId && d.id === profile.deviceId);
  const matches = exact ? [exact] : available.filter((d) => d.name === profile.deviceName);
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

export function realScanner({ prepare }) {
  let bridge;
  let profiles = [fallbackProfile];
  let devices = [];
  let profileId = fallbackProfile.id;
  let deviceId = null;
  let lastSuccessfulScanAt = null;
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
      };
    },
    async inspect(selection = {}) {
      profileId = selection.profileId ?? profileId;
      deviceId = selection.deviceId !== undefined ? selection.deviceId : deviceId;
      status = { ...status, state: 'checking', canScan: false, message: 'Checking Windows WIA…' };
      try {
        bridge ||= await prepare();
        provider.scans = bridge.scans;
        const inspection = bridge.inspect ? await bridge.inspect(profileId, deviceId) : null;
        const native = inspection || (await bridge.profiles());
        profiles = [fallbackProfile, ...native.profiles];
        const result = inspection || (await bridge.devices());
        devices = result.devices;
        const profile = profiles.find((p) => p.id === profileId);
        if (!profile)
          throw failure(
            'invalid_profile',
            'The selected profile no longer exists. Select a listed profile.',
          );
        profiles = profiles.map((p) => ({
          ...p,
          deviceMatch: (() => {
            const match = matchDevice(p, devices);
            return { matched: !!match.device, status: match.state };
          })(),
        }));
        const match = matchDevice(profile, devices, deviceId);
        status = {
          state: match.state,
          device: match.device || null,
          canScan: false,
          helperAvailable: true,
          profileWarnings: native.warnings || [],
          message: 'The configured scanner is not currently available.',
        };
        if (!profile.compatible) {
          status.state = 'unsupported_profile';
          status.message =
            'This native profile contains unsupported settings. Use the DigitalArch default or another compatible profile.';
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
    async scan(job) {
      // Recheck at scan time: discovery is not a guarantee that the device stayed available.
      await provider.inspect();
      if (!status.canScan) throw failure(status.state, status.message, 409);
      job.deviceId = status.device.id;
      job.profileId = profileId;
      try {
        await bridge.scan(job.id, { profileId, deviceId: status.device.id });
        lastSuccessfulScanAt = new Date().toISOString();
      } catch (error) {
        status = { ...status, state: 'scan_failed', canScan: false, message: error.message };
        throw error;
      }
    },
  };
  return provider;
}
