import React, { useState } from 'react';
import { Alert, Input, Modal } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { IconButton } from './ui';
import { pageName } from './pageLabels';

export default function PageLabelEditor({ page, disabled, error, onSave }) {
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  async function save() {
    if (disabled || saving) return;
    setSaving(true);
    try {
      if (await onSave(draft.trim() || null)) setDraft(null);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <IconButton
        label="Edit page label"
        icon={<EditOutlined aria-hidden />}
        disabled={disabled || saving}
        onClick={() => setDraft(page.page_label || '')}
      />
      <Modal
        title="Edit page label"
        open={draft !== null}
        width={400}
        maskClosable={false}
        okText="Save label"
        confirmLoading={saving}
        okButtonProps={{ disabled }}
        cancelButtonProps={{ disabled: saving }}
        onCancel={() => {
          if (!saving) setDraft(null);
        }}
        onOk={save}
      >
        {error && <Alert type="error" showIcon title={error} />}
        <label htmlFor={`page-label-${page.id}`}>Page label</label>
        <Input
          id={`page-label-${page.id}`}
          value={draft || ''}
          placeholder={pageName({ ...page, page_label: null })}
          maxLength={120}
          disabled={saving}
          allowClear
          onChange={(event) => setDraft(event.target.value)}
          onPressEnter={save}
        />
        <p className="muted">Leave blank to use the automatic page name.</p>
      </Modal>
    </>
  );
}
