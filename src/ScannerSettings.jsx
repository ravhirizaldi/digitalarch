import React from 'react';
import {
  Alert,
  Button,
  Collapse,
  Descriptions,
  Drawer,
  Form,
  InputNumber,
  Select,
  Space,
  Tag,
} from 'antd';
import { dateTime, statusLabels } from './ui';

export default function ScannerSettings({
  open,
  onClose,
  scanner,
  busy,
  scenario,
  setScenario,
  pageDelay,
  setPageDelay,
  onAction,
}) {
  const simulator = scanner.mode === 'simulator';
  const profile = scanner.profiles?.find((item) => item.id === scanner.profileId);
  return (
    <Drawer
      title="Scanner settings"
      open={open}
      onClose={onClose}
      size={480}
      destroyOnHidden
      mask={{ closable: false }}
      styles={{ body: { padding: 12 }, footer: { textAlign: 'right' } }}
      footer={<Button onClick={onClose}>Close settings</Button>}
    >
      <Space orientation="vertical" size={16} className="fill-width">
        <Alert
          type={scanner.canScan ? 'info' : 'warning'}
          showIcon
          title={statusLabels[scanner.state] || 'Loading scanner'}
          description={scanner.message || 'Reading scanner status'}
        />
        {simulator ? (
          <Form layout="vertical" size="small">
            <Form.Item label="Simulation scenario">
              <Select
                aria-label="Simulation Scenario"
                value={scenario}
                disabled={busy}
                onChange={setScenario}
                options={scanner.scenarios?.map((item) => ({ value: item.id, label: item.name }))}
              />
            </Form.Item>
            <Form.Item
              label="Page delay (ms)"
              extra="0–10000 ms between pages. No Windows or physical scanner access."
            >
              <InputNumber
                aria-label="Page Delay (ms)"
                min={0}
                max={10000}
                precision={0}
                value={pageDelay}
                disabled={busy}
                onChange={setPageDelay}
                className="fill-width"
              />
            </Form.Item>
          </Form>
        ) : (
          <>
            <Descriptions
              column={1}
              size="small"
              title="Selected profile"
              items={[
                { key: 'profile', label: 'Name', children: profile?.name || 'Not selected' },
                {
                  key: 'source',
                  label: 'Source',
                  children:
                    profile?.source === 'digitalarch'
                      ? 'DigitalArch · Application-managed'
                      : 'NAPS2 desktop · Read-only',
                },
                { key: 'driver', label: 'Driver', children: profile?.driver || 'WIA' },
                {
                  key: 'device',
                  label: 'Device',
                  children: scanner.device?.name || profile?.deviceName || 'Not detected',
                },
                {
                  key: 'identifier',
                  label: 'Device ID',
                  children: (
                    <span className="break-word">
                      {scanner.device?.id || profile?.deviceId || 'Resolved during discovery'}
                    </span>
                  ),
                },
                {
                  key: 'settings',
                  label: 'Acquisition',
                  children:
                    profile &&
                    `${profile.settings.paperSource} · ${profile.settings.pageSize} · ${profile.settings.dpi} dpi · ${profile.settings.colorMode} · ${profile.settings.pageAlign} aligned`,
                },
                {
                  key: 'checked',
                  label: 'Last checked',
                  children: dateTime(scanner.lastCheckedAt),
                },
                {
                  key: 'success',
                  label: 'Last real scan',
                  children: dateTime(scanner.lastSuccessfulScanAt),
                },
              ]}
            />
            <Alert
              type="info"
              showIcon
              title="Detection is not physical readiness"
              description="Device discovery does not prove paper availability, a connection, or mechanical readiness. Refresh after reconnecting or clearing a jam."
            />
            <Collapse
              size="small"
              items={[
                {
                  key: 'profiles',
                  label: 'Native NAPS2 profile notes',
                  children: (
                    <Space orientation="vertical" className="fill-width">
                      {scanner.profileWarnings?.map((warning, i) => (
                        <Alert key={i} type="warning" title={warning} />
                      ))}
                      {scanner.profiles
                        ?.filter((item) => item.source !== 'digitalarch')
                        .map((item) => (
                          <section key={item.id} className="profile-note">
                            <strong>{item.name}</strong>{' '}
                            <Tag color={item.compatible ? 'success' : 'warning'}>
                              {item.compatible ? 'Supported' : 'Unsupported'}
                            </Tag>
                            <p>
                              {item.deviceName} · {item.driver} ·{' '}
                              {item.deviceMatch?.matched ? 'Device matched' : 'Device not matched'}
                            </p>
                            <p>
                              {item.settings.paperSource} · {item.settings.pageSize} ·{' '}
                              {item.settings.dpi} dpi · {item.settings.colorMode}
                            </p>
                            {item.limitations?.length > 0 && (
                              <ul>
                                {item.limitations.map((note) => (
                                  <li key={note}>{note}</li>
                                ))}
                              </ul>
                            )}
                          </section>
                        ))}
                      {!scanner.profiles?.some((item) => item.source !== 'digitalarch') && (
                        <span className="muted">No native desktop profiles available</span>
                      )}
                    </Space>
                  ),
                },
              ]}
            />
          </>
        )}
        <Button onClick={() => onAction('refresh')} loading={scanner.checking} disabled={busy}>
          {simulator ? 'Refresh simulator' : 'Refresh Scanner'}
        </Button>
      </Space>
    </Drawer>
  );
}
