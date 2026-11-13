import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Descriptions,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { api } from './api';
import { dateTime } from './ui';
import { useTableHeight } from './BatchList';

export default function Administration({ view, user }) {
  const { modal } = App.useApp();
  const [result, setResult] = useState({ users: [], roles: [], logs: [] });
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [search, setSearch] = useState('');
  const [edit, setEdit] = useState(null);
  const [credentials, setCredentials] = useState(null);
  const [auditPage, setAuditPage] = useState(1);
  const [form] = Form.useForm();
  const [region, height] = useTableHeight();
  const load = useCallback(async () => {
    setWorking(true);
    try {
      setResult(
        await api(
          view === 'audit'
            ? `/api/admin/audit-logs?limit=25&offset=${(auditPage - 1) * 25}`
            : view === 'system'
              ? '/api/admin/system'
              : '/api/admin/users',
        ),
      );
      setError('');
    } catch (error) {
      setError(error.message);
    } finally {
      setWorking(false);
    }
  }, [view, auditPage]);
  useEffect(() => {
    load();
  }, [load]);
  async function mutate(operation) {
    setWorking(true);
    setError('');
    try {
      await operation();
      await load();
    } catch (error) {
      setError(error.message);
    } finally {
      setWorking(false);
    }
  }
  async function save(values) {
    await mutate(async () => {
      const response = await api(
        edit.id ? `/api/admin/users/${edit.id}` : '/api/admin/users',
        edit.id ? { ...values, version: edit.version } : values,
        edit.id ? 'PATCH' : 'POST',
      );
      if (response.temporaryPassword)
        setCredentials({ username: values.username, password: response.temporaryPassword });
      setEdit(null);
      form.resetFields();
    });
  }
  const columns = [
    { title: 'Username', dataIndex: 'username', width: 150 },
    { title: 'Display name', dataIndex: 'display_name', width: 180, ellipsis: true },
    {
      title: 'Roles',
      dataIndex: 'roles',
      width: 270,
      render: (roles) =>
        roles.map((role) => (
          <Tag key={role}>
            {result.roles?.find((item) => item.code === role)?.display_name || role}
          </Tag>
        )),
    },
    {
      title: 'Status',
      dataIndex: 'is_active',
      width: 100,
      render: (active) => (
        <Tag color={active ? 'success' : 'default'}>{active ? 'Active' : 'Disabled'}</Tag>
      ),
    },
    { title: 'Last login · WIB', dataIndex: 'last_login_at', width: 170, render: dateTime },
    { title: 'Created · WIB', dataIndex: 'created_at', width: 170, render: dateTime },
    {
      title: 'Action',
      width: 260,
      fixed: 'right',
      render: (_, account) => (
        <Space>
          <Button
            disabled={working}
            onClick={() => {
              setEdit(account);
              form.setFieldsValue({ displayName: account.display_name, roles: account.roles });
            }}
          >
            Edit
          </Button>
          <Button
            disabled={working || account.id === user.id}
            onClick={() =>
              modal.confirm({
                title: `${account.is_active ? 'Disable' : 'Enable'} ${account.username}?`,
                content: 'All current sessions for this account will be revoked.',
                onOk: () =>
                  mutate(() =>
                    api(
                      `/api/admin/users/${account.id}`,
                      { version: account.version, isActive: !account.is_active },
                      'PATCH',
                    ),
                  ),
              })
            }
          >
            {account.is_active ? 'Disable' : 'Enable'}
          </Button>
          <Button
            disabled={working}
            onClick={() =>
              modal.confirm({
                title: `Reset password for ${account.username}?`,
                content:
                  'Existing sessions will be revoked. A temporary password will be shown once.',
                onOk: () =>
                  mutate(async () => {
                    const response = await api(`/api/admin/users/${account.id}/reset-password`, {});
                    setCredentials({
                      username: account.username,
                      password: response.temporaryPassword,
                    });
                  }),
              })
            }
          >
            Reset
          </Button>
        </Space>
      ),
    },
  ];
  const auditColumns = [
    { title: 'Time · WIB', dataIndex: 'created_at', width: 180, render: dateTime },
    {
      title: 'Actor',
      dataIndex: 'actor',
      width: 140,
      render: (value) => value || 'Bootstrap / system',
    },
    { title: 'Action', dataIndex: 'action', width: 220 },
    { title: 'Entity', dataIndex: 'entity_type', width: 120 },
    { title: 'Entity ID', dataIndex: 'entity_id', width: 280, ellipsis: true },
    {
      title: 'Details',
      dataIndex: 'metadata',
      width: 300,
      ellipsis: true,
      render: (value) => JSON.stringify(value),
    },
  ];
  return (
    <section className="workspace" aria-label="Administration">
      <div className="workspace-toolbar">
        <h1>{view === 'audit' ? 'Audit Logs' : view === 'system' ? 'System' : 'Users'}</h1>
        {view === 'users' && (
          <>
            <Button
              type="primary"
              icon={<PlusOutlined aria-hidden />}
              disabled={working}
              onClick={() => {
                setEdit({});
                form.resetFields();
              }}
            >
              Create user
            </Button>
            <Input
              className="document-search"
              aria-label="Search users"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Username or display name"
              allowClear
            />
          </>
        )}
        <span className="toolbar-spacer" />
        <Button icon={<ReloadOutlined aria-hidden />} loading={working} onClick={load}>
          Refresh
        </Button>
      </div>
      {error && <Alert type="error" showIcon title={error} />}
      <div className="registry-table-region" ref={region}>
        {view === 'system' ? (
          <Descriptions
            className="system-details"
            bordered
            column={1}
            items={Object.entries(result).map(([key, value]) => ({
              key,
              label: key,
              children: typeof value === 'string' ? value : '—',
            }))}
          />
        ) : (
          <Table
            rowKey="id"
            size="small"
            loading={working}
            dataSource={
              view === 'audit'
                ? result.logs
                : result.users?.filter((account) =>
                    `${account.username} ${account.display_name}`
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  )
            }
            columns={view === 'audit' ? auditColumns : columns}
            scroll={{ x: 1400, y: height }}
            pagination={view === 'audit' ? false : { pageSize: 25 }}
          />
        )}
      </div>
      {view === 'audit' && (
        <Space>
          <Button
            disabled={working || auditPage === 1}
            onClick={() => setAuditPage((page) => page - 1)}
          >
            Previous
          </Button>
          <span>Page {auditPage}</span>
          <Button
            disabled={working || result.logs?.length < 25}
            onClick={() => setAuditPage((page) => page + 1)}
          >
            Next
          </Button>
        </Space>
      )}
      <Modal
        title={edit?.id ? `Edit ${edit.username}` : 'Create user'}
        open={!!edit}
        onCancel={() => {
          if (!working) setEdit(null);
        }}
        onOk={() => form.submit()}
        confirmLoading={working}
        destroyOnHidden
      >
        <p className="muted">
          Administrators do not inherit operational privileges. Capture/QC and approval roles must
          remain separate.
        </p>
        <Form form={form} layout="vertical" onFinish={save} disabled={working}>
          {!edit?.id && (
            <Form.Item
              label="Username"
              name="username"
              rules={[{ required: true, pattern: /^[a-zA-Z0-9_.-]{3,64}$/ }]}
            >
              <Input autoComplete="off" />
            </Form.Item>
          )}
          <Form.Item label="Display name" name="displayName" rules={[{ required: true, max: 120 }]}>
            <Input />
          </Form.Item>
          <Form.Item label="Roles" name="roles" rules={[{ required: true }]}>
            <Select
              mode="multiple"
              options={result.roles?.map((role) => ({
                value: role.code,
                label: role.display_name,
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="Temporary credentials · shown once"
        open={!!credentials}
        onCancel={() => setCredentials(null)}
        footer={
          <Button type="primary" onClick={() => setCredentials(null)}>
            I have saved these credentials
          </Button>
        }
      >
        <Alert
          type="warning"
          showIcon
          title="Store securely and share privately. The user must change this password on first sign-in."
        />
        <Descriptions
          column={1}
          items={[
            { key: 'username', label: 'Username', children: credentials?.username },
            {
              key: 'password',
              label: 'Temporary password',
              children: <code className="temporary-password">{credentials?.password}</code>,
            },
          ]}
        />
      </Modal>
    </section>
  );
}
