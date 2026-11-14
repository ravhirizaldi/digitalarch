import React, { memo, useEffect, useState } from 'react';
import { Button, Tooltip } from 'antd';

export const statusLabels = {
  simulator_ready: 'Ready',
  not_configured: 'Not Configured',
  checking: 'Checking Scanner',
  device_not_found: 'Scanner Not Found',
  device_detected: 'Scanner Detected',
  capabilities_verified: 'Capabilities Verified',
  driver_error: 'Driver Error',
  helper_unavailable: 'Scanner Helper Unavailable',
  scan_failed: 'Scan Failed',
  profile_mismatch: 'Profile Mismatch',
  unsupported_profile: 'Unsupported Profile',
  ambiguous_device: 'Select a Device',
  unsupported_settings: 'Unsupported Settings',
  capabilities_unavailable: 'Capabilities Unavailable',
  timeout: 'Inspection Timed Out',
};
export const dateTime = (value) =>
  value
    ? new Date(value).toLocaleString('en-GB', { timeZone: 'Asia/Jakarta', hour12: false })
    : 'Not recorded';
export function IconButton({ label, icon, ...props }) {
  return (
    <Tooltip title={label} trigger={['hover', 'focus']}>
      <Button aria-label={label} icon={icon} {...props} />
    </Tooltip>
  );
}
export const Thumbnail = memo(function Thumbnail({ src, rotation = 0, label }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <span className="thumbnail-media">
      {failed ? (
        <span className="thumbnail-error">No preview</span>
      ) : (
        <img
          src={src}
          alt={label}
          loading="lazy"
          onError={() => setFailed(true)}
          style={{ transform: `rotate(${rotation}deg) scale(${rotation % 180 ? 0.78 : 1})` }}
        />
      )}
    </span>
  );
});
export function useNarrow() {
  const [narrow, setNarrow] = useState(() => matchMedia('(max-width: 959px)').matches);
  useEffect(() => {
    const media = matchMedia('(max-width: 959px)');
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return narrow;
}
