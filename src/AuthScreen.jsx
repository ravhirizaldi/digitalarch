import React, { useState } from 'react';
import { Alert, Button, Form, Input, Modal, Space } from 'antd';
import { ScanOutlined } from '@ant-design/icons';
import { api } from './api';

export default function AuthScreen({ user, onAuthenticated, onCancel, initialError = '' }) {
  const [error, setError] = useState(initialError);
  const [working, setWorking] = useState(false);
  const change = !!user;
  async function submit(values) {
    setWorking(true);
    setError('');
    try {
      await onAuthenticated(
        await api(change ? '/api/auth/change-password' : '/api/auth/login', values),
      );
    } catch (error) {
      setError(error.message);
    } finally {
      setWorking(false);
    }
  }
  const form = (
    <>
      {error && <Alert showIcon type="error" title={error} />}
      <Form layout="vertical" onFinish={submit} disabled={working} requiredMark={false}>
        {!change && (
          <Form.Item label="Username" name="username" rules={[{ required: true }]}>
            <Input autoFocus autoComplete="username" maxLength={64} />
          </Form.Item>
        )}
        <Form.Item
          label={change ? 'Current password' : 'Password'}
          name={change ? 'currentPassword' : 'password'}
          rules={[{ required: true }]}
        >
          <Input.Password autoFocus={change} autoComplete="current-password" maxLength={256} />
        </Form.Item>
        {change && (
          <Form.Item
            label="New password"
            name="newPassword"
            extra="At least 12 characters. Use a unique passphrase."
            rules={[{ required: true, min: 12, max: 256 }]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        )}
        {change ? (
          <Space>
            <Button type="primary" htmlType="submit" loading={working}>
              Change password
            </Button>
            {onCancel && (
              <Button onClick={onCancel} disabled={working}>
                Cancel
              </Button>
            )}
          </Space>
        ) : (
          <Button type="primary" htmlType="submit" loading={working} block>
            Sign in
          </Button>
        )}
      </Form>
    </>
  );
  if (change)
    return (
      <Modal
        title={user.must_change_password ? 'Choose your password' : 'Change password'}
        open
        centered
        width={400}
        footer={null}
        onCancel={onCancel}
        closable={!!onCancel && !working}
        keyboard={!!onCancel && !working}
        mask={{ closable: false }}
      >
        <p className="muted">
          {user.must_change_password
            ? 'Your temporary password must be changed before opening a workspace.'
            : 'Use a unique passphrase. Your current workspace will stay open.'}
        </p>
        {form}
      </Modal>
    );
  return (
    <main className="auth-screen">
      <section className="auth-panel" aria-label="Sign in">
        <div className="auth-brand">
          <ScanOutlined /> DigitalArch
        </div>
        <h1>Sign in to your workstation</h1>
        <p className="muted">Use the account provided by your system administrator.</p>
        {form}
      </section>
    </main>
  );
}
