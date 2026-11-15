import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Form, Input, Switch } from 'antd';
import { api } from './api';

export default function ApprovalSettings({ user }) {
  const [form] = Form.useForm();
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const populate = useCallback(
    (next) => {
      setSettings(next);
      form.setFieldsValue({
        l2Required: next.l2_required,
        l1Label: next.l1_label,
        l2Label: next.l2_label,
      });
    },
    [form],
  );
  useEffect(() => {
    api('/api/settings/approval')
      .then(({ settings }) => populate(settings))
      .catch((error) => setError(error.message));
  }, [populate]);
  async function save(values) {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const result = await api(
        '/api/settings/approval',
        { ...values, version: settings.version },
        'PATCH',
      );
      populate(result.settings);
      setSaved(true);
    } catch (error) {
      setError(error.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="approval-settings-section" aria-label="Approval policy">
      <h2>Approval policy</h2>
      <p>
        Each batch keeps the policy fixed at its first QC Pass. Changing this setting never
        publishes or reroutes existing batches.
      </p>
      {error && (
        <Alert
          type="error"
          showIcon
          title={error}
          action={
            <Button
              onClick={() =>
                api('/api/settings/approval')
                  .then(({ settings }) => {
                    populate(settings);
                    setError('');
                  })
                  .catch((error) => setError(error.message))
              }
            >
              Reload policy
            </Button>
          }
        />
      )}
      {saved && (
        <Alert type="success" showIcon title="Approval policy saved for future first QC passes." />
      )}
      <Form
        form={form}
        layout="vertical"
        className="ocr-settings-form"
        onFinish={save}
        disabled={!settings || saving || !user.permissions.includes('settings:manage')}
      >
        <Form.Item
          label="Require L2 confirmation"
          name="l2Required"
          valuePropName="checked"
          extra="Off: L1 explicitly approves and publishes. On: L1 selects the L2 authority, who must confirm publication."
        >
          <Switch checkedChildren="L1 → L2" unCheckedChildren="L1 only" />
        </Form.Item>
        <div className="admin-form-grid">
          <Form.Item
            label="L1 display name"
            name="l1Label"
            rules={[{ required: true, whitespace: true, max: 80 }]}
          >
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item
            label="L2 display name"
            name="l2Label"
            rules={[{ required: true, whitespace: true, max: 80 }]}
          >
            <Input maxLength={80} />
          </Form.Item>
        </div>
        <Button type="primary" htmlType="submit" loading={saving}>
          Save approval policy
        </Button>
      </Form>
    </section>
  );
}
