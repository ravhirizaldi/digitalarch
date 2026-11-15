import React, { useId } from 'react';
import { Alert, Button, Drawer, Input, Space } from 'antd';

export default function BatchInfo({
  open,
  onClose,
  location,
  onChange,
  onSave,
  saving,
  editable = true,
  error,
  children,
}) {
  const locationId = useId();
  return (
    <Drawer title="Batch Info" open={open} onClose={onClose} size={360}>
      <Space orientation="vertical" className="batch-info-fields">
        <p>Physical location is optional and may be shared by multiple batches.</p>
        {error && <Alert type="error" title={error} />}
        <label htmlFor={locationId}>Physical location</label>
        <Input
          id={locationId}
          value={location}
          maxLength={240}
          placeholder="Rack A-12, Box 017…"
          disabled={!editable || saving}
          onChange={(event) => onChange(event.target.value)}
        />
        {editable ? (
          <Button type="primary" loading={saving} onClick={onSave}>
            Save location
          </Button>
        ) : (
          <p>Read-only. Changes require operator preparation/rework or your live QC claim.</p>
        )}
        {children}
      </Space>
    </Drawer>
  );
}
