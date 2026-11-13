import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Descriptions, Form, Select, Spin } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { api } from './api';
import { dateTime } from './ui';

const stepLabels = {
  grayscale: 'Grayscale',
  contrast: 'Contrast adjustment',
  deskew: 'Deskew',
  denoise: 'Light denoising',
  adaptiveThreshold: 'Adaptive threshold',
  lineRemoval: 'Diagonal line removal (experimental)',
};

export default function OcrSettings({ user }) {
  const [form] = Form.useForm();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const engine = Form.useWatch('engine', form) || 'tesseract';
  const canManage = user.permissions.includes('settings:manage');
  const populate = useCallback(
    (defaults) => {
      const config = defaults.processing_config;
      form.setFieldsValue({
        engine: config.engine || 'tesseract',
        language: defaults.language,
        profile: config.profile,
        psm: config.psm,
        layout: config.layout || 'page',
        cpuThreads: config.cpuThreads || 1,
        steps: Object.entries(config.preprocessing)
          .filter(([, value]) => value)
          .map(([key]) => key),
      });
    },
    [form],
  );
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setSaved(false);
    try {
      const result = await api('/api/settings/ocr');
      setData(result);
      populate(result.defaults);
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }, [populate]);
  useEffect(() => {
    load();
  }, [load]);
  async function save(values) {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const { steps = [], cpuThreads, ...rest } = values;
      const preprocessing = Object.fromEntries(
        Object.keys(stepLabels)
          .filter((key) => key !== 'lineRemoval' || steps.includes(key))
          .map((key) => [key, steps.includes(key)]),
      );
      const result = await api(
        '/api/settings/ocr',
        {
          ...rest,
          ...(rest.engine === 'paddleocr' ? { cpuThreads } : {}),
          preprocessing,
          version: data.defaults.version,
        },
        'PATCH',
      );
      setData((current) => ({ ...current, ...result }));
      populate(result.defaults);
      setSaved(true);
    } catch (error) {
      setError(error.message);
    } finally {
      setSaving(false);
    }
  }
  const selected = data?.engines.find((item) => item.id === engine);
  return (
    <section className="workspace" aria-label="Global settings">
      <div className="workspace-toolbar">
        <h1>Settings</h1>
        <span className="toolbar-spacer" />
        <Button
          icon={<ReloadOutlined aria-hidden />}
          disabled={saving}
          loading={loading}
          onClick={load}
        >
          Reload settings
        </Button>
      </div>
      {error && <Alert type="error" title={error} showIcon />}
      {saved && (
        <Alert
          type="success"
          title="Global OCR defaults saved. Existing jobs and results were not changed."
          showIcon
        />
      )}
      <div className="ocr-settings-body" aria-busy={loading || saving}>
        {loading && !data ? (
          <Spin />
        ) : (
          data && (
            <>
              <h2>OCR defaults</h2>
              <p>
                Applies to new captures, Send to OCR and Reprocess for every operator. Running,
                queued and historical jobs keep their saved settings.
              </p>
              {selected?.error && <Alert type="warning" title={selected.error} showIcon />}
              <Form
                form={form}
                layout="vertical"
                className="ocr-settings-form"
                onFinish={save}
                disabled={loading || saving || !canManage}
              >
                <Form.Item name="engine" label="OCR engine" rules={[{ required: true }]}>
                  <Select
                    options={data.engines.map((item) => ({
                      value: item.id,
                      label: item.name,
                      disabled: !item.available,
                    }))}
                    onChange={(value) => {
                      if (value === 'paddleocr') form.setFieldsValue({ psm: 3, layout: 'page' });
                    }}
                  />
                </Form.Item>
                <Form.Item name="language" label="Languages" rules={[{ required: true }]}>
                  <Select
                    options={[
                      { value: 'ind+eng', label: 'Indonesian + English' },
                      { value: 'ind', label: 'Indonesian' },
                      { value: 'eng', label: 'English' },
                      { value: 'eng+ind', label: 'English + Indonesian' },
                    ]}
                  />
                </Form.Item>
                <Form.Item
                  name="profile"
                  label="Preprocessing profile"
                  rules={[{ required: true }]}
                >
                  <Select
                    options={[
                      { value: 'standard', label: 'Standard' },
                      { value: 'enhanced', label: 'Enhanced' },
                      { value: 'high-accuracy', label: 'High accuracy (adaptive)' },
                    ]}
                    onChange={(profile) =>
                      form.setFieldValue(
                        'steps',
                        Object.entries(
                          data.profiles.find((item) => item.id === profile).preprocessing,
                        )
                          .filter(([, value]) => value)
                          .map(([key]) => key),
                      )
                    }
                  />
                </Form.Item>
                <Form.Item
                  name="cpuThreads"
                  label="PaddleOCR CPU threads"
                  extra={
                    engine === 'paddleocr'
                      ? 'Thread budget, not dedicated cores. Page concurrency remains 1.'
                      : 'Tesseract thread control is not exposed by NAPS2.'
                  }
                >
                  <Select
                    disabled={engine !== 'paddleocr' || loading || saving || !canManage}
                    options={data.hardware.paddleThreadOptions.map((value) => ({
                      value,
                      label: `${value} ${value === 1 ? 'thread' : 'threads'}`,
                    }))}
                  />
                </Form.Item>
                <Form.Item name="psm" label="Tesseract page segmentation">
                  <Select
                    disabled={engine === 'paddleocr' || loading || saving || !canManage}
                    options={[
                      { value: 3, label: 'PSM 3 · Auto' },
                      { value: 4, label: 'PSM 4 · Column' },
                      { value: 6, label: 'PSM 6 · Block' },
                    ]}
                  />
                </Form.Item>
                <Form.Item name="layout" label="Tesseract layout">
                  <Select
                    disabled={engine === 'paddleocr' || loading || saving || !canManage}
                    options={[
                      { value: 'page', label: 'Whole page' },
                      { value: 'regions', label: 'Automatic regions (opt-in)' },
                    ]}
                  />
                </Form.Item>
                <Form.Item
                  name="steps"
                  label="Preprocessing steps"
                  className="ocr-settings-wide"
                  extra="Applied only to temporary OCR input. Line removal may damage recognition; it is off unless explicitly selected."
                >
                  <Checkbox.Group
                    className="ocr-settings-steps"
                    options={Object.entries(stepLabels).map(([value, label]) => ({ value, label }))}
                  />
                </Form.Item>
                <div className="ocr-settings-wide">
                  <Button
                    type="primary"
                    htmlType="submit"
                    loading={saving}
                    disabled={loading || !canManage || !selected?.available}
                  >
                    Save global defaults
                  </Button>
                </div>
              </Form>
              <h2>Model and workstation</h2>
              <Descriptions
                size="small"
                column={2}
                items={[
                  {
                    key: 'model',
                    label: 'Selected model',
                    children: selected?.model || 'Unavailable',
                  },
                  {
                    key: 'version',
                    label: 'Runtime',
                    children: selected?.version
                      ? `${selected.name} ${selected.version} · CPU`
                      : 'NAPS2 / Tesseract · CPU',
                  },
                  { key: 'cpu', label: 'CPU', children: data.hardware.cpu },
                  {
                    key: 'available',
                    label: 'Available logical CPUs',
                    children: `${data.hardware.availableCpus} of ${data.hardware.logicalCpus}`,
                  },
                  {
                    key: 'ram',
                    label: 'System RAM',
                    children: `${(data.hardware.totalMemoryBytes / 1073741824).toFixed(1)} GiB`,
                  },
                  { key: 'pages', label: 'Page concurrency', children: 1 },
                  { key: 'dpi', label: 'Scanner resolution', children: '300 DPI (unchanged)' },
                  {
                    key: 'deadline',
                    label: 'Page timeout / attempts',
                    children: `${data.limits.timeoutSeconds}s / ${data.limits.maxAttempts}`,
                  },
                  {
                    key: 'saved',
                    label: 'Last saved · WIB',
                    children: dateTime(data.defaults.updated_at),
                  },
                ]}
              />
              <p className="muted">
                PaddleOCR Small used about 957 MiB peak engine RAM in the initial benchmark. A small
                model does not imply a small runtime. No GPU, additional OCR processes or scanner
                changes are enabled here.
              </p>
            </>
          )
        )}
      </div>
    </section>
  );
}
