import React, { useState } from 'react';
import { Alert, Button, Form, Input } from 'antd';
import { ScanOutlined } from '@ant-design/icons';
import { api } from './api';

export default function AuthScreen({ user, onAuthenticated, initialError = '' }) {
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
  return (
    <main className="auth-screen">
      <section className="auth-panel" aria-label={change ? 'Change password' : 'Sign in'}>
        <div className="auth-brand">
          <ScanOutlined /> DigitalArch
        </div>
        <h1>{change ? 'Choose your password' : 'Sign in to your workstation'}</h1>
        <p className="muted">
          {change
            ? 'Your temporary password must be changed before opening a workspace.'
            : 'Use the account provided by your system administrator.'}
        </p>
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
            <Input.Password autoComplete="current-password" maxLength={256} />
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
          <Button type="primary" htmlType="submit" loading={working} block>
            {change ? 'Change password' : 'Sign in'}
          </Button>
        </Form>
      </section>
    </main>
  );
}
