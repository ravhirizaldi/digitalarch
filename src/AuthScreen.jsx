import React, { useEffect, useState } from 'react';
import { Alert, Button, Form, Input, Modal, Space } from 'antd';
import { FileTextOutlined, LockOutlined, ScanOutlined } from '@ant-design/icons';
import { api } from './api';

export default function AuthScreen({ user, onAuthenticated, onCancel, initialError = '' }) {
  const [error, setError] = useState(initialError);
  const [working, setWorking] = useState(false);
  const [register, setRegister] = useState(window.location.pathname === '/register');
  const [status, setStatus] = useState(null);
  const [fields] = Form.useForm();
  const change = !!user;
  useEffect(() => {
    if (change) return;
    const restore = () => {
      setRegister(window.location.pathname === '/register');
      setStatus(null);
      setError('');
      fields.resetFields();
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [change, fields]);
  function switchPage(next) {
    if (working) return;
    window.history.pushState(null, '', next ? '/register' : '/login');
    setRegister(next);
    setStatus(null);
    setError('');
    fields.resetFields();
  }
  async function submit(values) {
    setWorking(true);
    setError('');
    try {
      const result = await api(
        change ? '/api/auth/change-password' : register ? '/api/auth/register' : '/api/auth/login',
        values,
      );
      fields.resetFields();
      if (result.registrationStatus) setStatus(result.registrationStatus);
      else await onAuthenticated(result);
    } catch (error) {
      setError(error.message);
    } finally {
      setWorking(false);
    }
  }
  const form = (
    <>
      {error && <Alert showIcon type="error" title={error} />}
      <Form
        className={!change && register ? 'auth-register-form' : undefined}
        key={change ? 'change' : register ? 'register' : 'login'}
        form={fields}
        layout="vertical"
        onFinish={submit}
        disabled={working}
        requiredMark={false}
      >
        {!change && register && (
          <Form.Item
            label="Full name"
            name="displayName"
            rules={[{ required: true, whitespace: true, max: 120 }]}
          >
            <Input autoComplete="name" maxLength={120} autoFocus />
          </Form.Item>
        )}
        {!change && (
          <Form.Item
            label="Username"
            name="username"
            rules={[
              { required: true },
              ...(register
                ? [
                    {
                      pattern: /^[a-zA-Z0-9_.-]{3,64}$/,
                      message: 'Use 3–64 letters, digits, dots, dashes or underscores.',
                    },
                  ]
                : []),
            ]}
          >
            <Input
              autoFocus={!register}
              autoComplete="username"
              maxLength={64}
              autoCapitalize="none"
              spellCheck={false}
            />
          </Form.Item>
        )}
        <Form.Item
          label={change ? 'Current password' : 'Password'}
          name={change ? 'currentPassword' : 'password'}
          rules={[
            { required: true },
            ...(!change && register
              ? [{ min: 12, max: 256, message: 'Use 12–256 characters.' }]
              : []),
          ]}
          extra={
            !change && register ? 'At least 12 characters. Use a unique passphrase.' : undefined
          }
        >
          <Input.Password
            autoFocus={change}
            autoComplete={!change && register ? 'new-password' : 'current-password'}
            maxLength={256}
          />
        </Form.Item>
        {!change && register && (
          <Form.Item
            label="Confirm password"
            name="confirmPassword"
            dependencies={['password']}
            rules={[
              { required: true },
              ({ getFieldValue }) => ({
                validator: (_, value) =>
                  !value || value === getFieldValue('password')
                    ? Promise.resolve()
                    : Promise.reject(new Error('Passwords must match.')),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" maxLength={256} />
          </Form.Item>
        )}
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
            {register ? 'Request viewer access' : 'Sign in'}
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
      <aside className="auth-introduction">
        <div className="auth-brand">
          <ScanOutlined aria-hidden /> DigitalArch
        </div>
        <div className="auth-introduction-copy">
          <FileTextOutlined className="auth-document-icon" aria-hidden />
          <h2>A clear path to your documents.</h2>
          <p>
            Find published records, inspect page images and keep the documents you need open
            together.
          </p>
        </div>
        <p className="auth-access-note">
          <LockOutlined aria-hidden /> Approved access. Recorded activity.
        </p>
      </aside>
      <section
        className={`auth-panel${register ? ' auth-panel-register' : ''}`}
        aria-label={register ? 'Viewer registration' : 'Sign in'}
      >
        <h1>
          {status
            ? status === 'pending'
              ? 'Waiting for approval'
              : 'Request not approved'
            : register
              ? 'Create a viewer account'
              : 'Welcome back'}
        </h1>
        <p className="muted">
          {status
            ? 'Viewer access is managed by your administrator.'
            : register
              ? 'Browse published documents after an administrator approves your request.'
              : 'Sign in to open your DigitalArch workspace.'}
        </p>
        {status ? (
          <>
            <Alert
              showIcon
              type={status === 'pending' ? 'info' : 'warning'}
              title={
                status === 'pending' ? 'Your request is pending.' : 'Your request was rejected.'
              }
              description={
                status === 'pending'
                  ? 'You can sign in again after an administrator approves your account. No documents are accessible yet.'
                  : 'Contact your administrator if you need access.'
              }
            />
            <Button block onClick={() => switchPage(false)}>
              Back to sign in
            </Button>
          </>
        ) : (
          <>
            {form}
            <p className="auth-switch">
              {register ? 'Already have an account?' : 'Need access to published documents?'}{' '}
              <a
                href={register ? '/login' : '/register'}
                aria-disabled={working}
                onClick={(e) => {
                  e.preventDefault();
                  switchPage(!register);
                }}
              >
                {register ? 'Sign in' : 'Register as a viewer'}
              </a>
            </p>
          </>
        )}
      </section>
    </main>
  );
}
