import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  App,
  Badge,
  Button,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Tabs,
  Tag,
} from 'antd';
import {
  AuditOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  ClearOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  FileTextOutlined,
  KeyOutlined,
  LockOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ScanOutlined,
  SearchOutlined,
  StopOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { api } from './api';
import { dateTime, IconButton } from './ui';
import WorklistTable, { ColumnHeading } from './WorklistTable';
import { queryChoice, queryPage, useUrlState } from './useUrlState';

const roleIcons = {
  system_admin: <SafetyCertificateOutlined aria-hidden />,
  operator: <ScanOutlined aria-hidden />,
  qc_officer: <CheckCircleOutlined aria-hidden />,
  approver_l1: <AuditOutlined aria-hidden />,
  approver_l2: <SafetyCertificateOutlined aria-hidden />,
  archive_viewer: <EyeOutlined aria-hidden />,
};
const categoryNames = {
  auth: 'Sign-in & security',
  user: 'Users & roles',
  batch: 'Batches',
  scan_session: 'Capture sessions',
  page: 'Pages',
  document: 'Documents',
  metadata: 'Metadata',
  ocr: 'OCR',
  qc: 'Quality control',
  viewer_registration: 'Viewer registrations',
  viewer_access: 'Viewer access',
  viewer_activity: 'Viewer activity',
  viewer_download: 'Viewer downloads',
};
const readable = (value) => value.replaceAll('_', ' ').replaceAll('.', ' · ');
const heading = (icon, title) => <ColumnHeading icon={icon}>{title}</ColumnHeading>;

function readAdminState(params) {
  const size = Number(queryChoice(params, 'size', ['25', '50', '100']));
  return {
    role: queryChoice(params, 'role', ['all', ...Object.keys(roleIcons)]),
    category: /^[a-z][a-z0-9_]{0,63}$/.test(params.get('category') || '')
      ? params.get('category')
      : 'all',
    q: (params.get('q') || '').slice(0, 240),
    page: Math.min(queryPage(params, 'page'), Math.floor(1_000_000 / size) + 1),
    size,
    sort: queryChoice(params, 'sort', ['username', 'is_active', 'last_login_at', 'created_at']),
    direction: queryChoice(params, 'direction', ['asc', 'desc']),
  };
}

export default function Administration({ view, user }) {
  const { modal } = App.useApp();
  const [result, setResult] = useState({ users: [], roles: [], logs: [], counts: {} });
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [working, setWorking] = useState(false);
  const [edit, setEdit] = useState(null);
  const [credentials, setCredentials] = useState(null);
  const [event, setEvent] = useState(null);
  const [selectedKeys, setSelectedKeys] = useState([]);
  const [query, setQuery] = useUrlState(readAdminState);
  const { role, category, q: search, page, size: pageSize, sort, direction } = query;
  const [form] = Form.useForm();
  const passwordMode = Form.useWatch('passwordMode', form);
  const requestId = useRef(0);
  const auditQuery =
    view === 'audit'
      ? new URLSearchParams({
          category,
          search,
          limit: String(pageSize),
          offset: String((page - 1) * pageSize),
        }).toString()
      : '';
  const load = useCallback(async () => {
    const request = ++requestId.current;
    setWorking(true);
    try {
      const next = await api(
        view === 'audit'
          ? `/api/admin/audit-logs?${auditQuery}`
          : view === 'system'
            ? '/api/admin/system'
            : '/api/admin/users',
      );
      if (request !== requestId.current) return;
      setResult(next);
      setError('');
    } catch (error) {
      if (request === requestId.current) setError(error.message);
    } finally {
      if (request === requestId.current) setWorking(false);
    }
  }, [view, auditQuery]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    setSelectedKeys([]);
  }, [role, search]);

  function openEditor(account = {}, resetPassword = false) {
    form.resetFields();
    setFormError('');
    setEdit({ ...account, resetPassword });
    form.setFieldsValue({
      displayName: account.display_name,
      roles: account.roles || (role === 'all' ? [] : [role]),
      passwordMode: 'auto',
    });
  }
  function closeEditor() {
    if (working) return;
    form.resetFields();
    setFormError('');
    setEdit(null);
  }
  async function save(values) {
    setWorking(true);
    setFormError('');
    try {
      const password = values.passwordMode === 'manual' ? { password: values.password } : {};
      const response = await api(
        edit.targets
          ? '/api/admin/users/bulk'
          : edit.resetPassword
            ? `/api/admin/users/${edit.id}/reset-password`
            : edit.id
              ? `/api/admin/users/${edit.id}`
              : '/api/admin/users',
        edit.targets
          ? { action: 'reset-password', users: edit.targets, ...password }
          : edit.resetPassword
            ? { ...password, version: edit.version }
            : edit.id
              ? { displayName: values.displayName, roles: values.roles, version: edit.version }
              : {
                  username: values.username,
                  displayName: values.displayName,
                  roles: values.roles,
                  ...password,
                },
        edit.id && !edit.resetPassword ? 'PATCH' : 'POST',
      );
      if (response.temporaryPassword)
        setCredentials([
          {
            username: edit.username || values.username,
            password: response.temporaryPassword,
          },
        ]);
      if (response.credentials?.length) setCredentials(response.credentials);
      setSelectedKeys([]);
      setEdit(null);
      form.resetFields();
      await load();
    } catch (error) {
      setFormError(error.message);
    } finally {
      setWorking(false);
    }
  }
  async function toggleAccount(account) {
    setWorking(true);
    setError('');
    try {
      await api(
        `/api/admin/users/${account.id}`,
        {
          version: account.version,
          isActive: !account.is_active,
        },
        'PATCH',
      );
      await load();
    } catch (error) {
      setError(error.message);
      throw error;
    } finally {
      setWorking(false);
    }
  }

  function confirmDelete(accounts) {
    modal.confirm({
      title:
        accounts.length === 1
          ? `Delete ${accounts[0].username}?`
          : `Delete ${accounts.length} users?`,
      content: (
        <>
          <p>
            Accounts will be removed from Users and all their sessions revoked. They cannot sign in
            again.
          </p>
          <p>
            Document ownership, original scans and audit history are retained. Usernames remain
            reserved. Assigned work may need reassignment.
          </p>
          <p className="admin-delete-names">
            {accounts.map((account) => account.username).join(', ')}
          </p>
        </>
      ),
      okText: accounts.length === 1 ? 'Delete user' : 'Delete users',
      okButtonProps: { danger: true },
      async onOk() {
        setWorking(true);
        setError('');
        try {
          await api('/api/admin/users/bulk', {
            action: 'delete',
            users: accounts.map(({ id, version }) => ({ id, version })),
          });
          setSelectedKeys([]);
          await load();
        } catch (error) {
          setError(error.message);
          throw error;
        } finally {
          setWorking(false);
        }
      },
    });
  }
  const users = result.users || [];
  const selected = users.filter((account) => selectedKeys.includes(account.id));
  const filtered = users.filter(
    (account) =>
      (role === 'all' || account.roles.includes(role)) &&
      `${account.username} ${account.display_name}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  filtered.sort((a, b) => {
    const left = a[sort] ?? '',
      right = b[sort] ?? '';
    const order =
      typeof left === 'boolean'
        ? Number(left) - Number(right)
        : String(left).localeCompare(String(right));
    return (direction === 'asc' ? order : -order) || a.username.localeCompare(b.username);
  });
  const currentPage =
    view === 'users' ? Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize))) : page;
  const sortable = (key) => ({
    key,
    sorter: true,
    sortOrder: sort === key ? (direction === 'asc' ? 'ascend' : 'descend') : null,
  });
  const columns = [
    {
      ...sortable('username'),
      title: heading(<UserOutlined aria-hidden />, 'Account'),
      dataIndex: 'username',
      width: 230,
      render: (_, account) => (
        <div className="admin-cell">
          <span className="admin-account-name" title={account.display_name}>
            <strong>{account.display_name}</strong>
            {account.id === user.id && <Tag>You</Tag>}
          </span>
          <span className="admin-cell-secondary" title={account.username}>
            {account.username}
          </span>
        </div>
      ),
    },
    {
      title: heading(<SafetyCertificateOutlined aria-hidden />, 'Roles'),
      dataIndex: 'roles',
      width: 280,
      render: (roles) => (
        <div className="admin-role-tags">
          {roles.map((code) => (
            <Tag
              key={code}
              icon={roleIcons[code]}
              color={code === 'system_admin' ? 'blue' : undefined}
            >
              {result.roles?.find((item) => item.code === code)?.display_name || readable(code)}
            </Tag>
          ))}
        </div>
      ),
    },
    {
      ...sortable('is_active'),
      title: heading(<CheckCircleOutlined aria-hidden />, 'Access'),
      dataIndex: 'is_active',
      width: 160,
      render: (active, account) => (
        <div className="admin-cell">
          <Tag
            color={active ? 'success' : 'default'}
            icon={active ? <CheckCircleOutlined aria-hidden /> : <StopOutlined aria-hidden />}
          >
            {active ? 'Active' : 'Disabled'}
          </Tag>
          {account.must_change_password && (
            <span className="admin-cell-secondary">Password change required</span>
          )}
        </div>
      ),
    },
    {
      ...sortable('last_login_at'),
      title: heading(<ClockCircleOutlined aria-hidden />, 'Last sign-in · WIB'),
      dataIndex: 'last_login_at',
      width: 175,
      render: (value) => (value ? dateTime(value) : <span className="muted">Never signed in</span>),
    },
    {
      ...sortable('created_at'),
      title: heading(<CalendarOutlined aria-hidden />, 'Created · WIB'),
      dataIndex: 'created_at',
      width: 175,
      render: dateTime,
    },
    {
      title: heading(<EditOutlined aria-hidden />, 'Actions'),
      width: 152,
      fixed: 'right',
      render: (_, account) => (
        <Space size={4}>
          <IconButton
            label="Edit user"
            icon={<EditOutlined aria-hidden />}
            disabled={working}
            onClick={() => openEditor(account)}
          />
          <IconButton
            label={account.is_active ? 'Disable user' : 'Enable user'}
            icon={
              account.is_active ? <StopOutlined aria-hidden /> : <CheckCircleOutlined aria-hidden />
            }
            danger={account.is_active}
            disabled={working || account.id === user.id}
            onClick={() =>
              modal.confirm({
                title: `${account.is_active ? 'Disable' : 'Enable'} ${account.username}?`,
                content: 'All current sessions for this account will be revoked.',
                okText: account.is_active ? 'Disable user' : 'Enable user',
                okButtonProps: { danger: account.is_active },
                onOk: () => toggleAccount(account),
              })
            }
          />
          <IconButton
            label="Reset password"
            icon={<KeyOutlined aria-hidden />}
            disabled={working}
            onClick={() => openEditor(account, true)}
          />
          {user.permissions.includes('users:delete') && (
            <IconButton
              label="Delete user"
              icon={<DeleteOutlined aria-hidden />}
              danger
              disabled={working || account.id === user.id}
              onClick={() => confirmDelete([account])}
            />
          )}
        </Space>
      ),
    },
  ];
  const auditColumns = [
    {
      title: heading(<ClockCircleOutlined aria-hidden />, 'Time · WIB'),
      dataIndex: 'created_at',
      width: 175,
      render: dateTime,
    },
    {
      title: heading(<UserOutlined aria-hidden />, 'Actor'),
      dataIndex: 'actor',
      width: 165,
      ellipsis: true,
      render: (value) => value || 'Bootstrap / system',
    },
    {
      title: heading(<AuditOutlined aria-hidden />, 'Event'),
      dataIndex: 'action',
      width: 240,
      render: (value) => (
        <div className="admin-cell">
          <strong className="admin-event-name">{readable(value)}</strong>
          <span className="admin-cell-secondary">{value}</span>
        </div>
      ),
    },
    {
      title: heading(<FileTextOutlined aria-hidden />, 'Record'),
      width: 245,
      render: (_, log) => (
        <div className="admin-cell">
          <span>{readable(log.entity_type)}</span>
          <span className="admin-cell-secondary" title={log.entity_id}>
            {log.entity_id || '—'}
          </span>
        </div>
      ),
    },
    {
      title: heading(<FileTextOutlined aria-hidden />, 'Details'),
      dataIndex: 'metadata',
      width: 220,
      ellipsis: true,
      render: (value) =>
        Object.keys(value || {}).length ? (
          JSON.stringify(value)
        ) : (
          <span className="muted">No additional details</span>
        ),
    },
    {
      title: heading(<EyeOutlined aria-hidden />, 'View'),
      width: 64,
      fixed: 'right',
      align: 'center',
      render: (_, log) => (
        <IconButton
          label="View event details"
          icon={<EyeOutlined aria-hidden />}
          onClick={() => setEvent(log)}
        />
      ),
    },
  ];
  const auditCounts = result.counts || {};
  const allEvents = Object.values(auditCounts).reduce((sum, count) => sum + count, 0);
  const tabs =
    view === 'audit'
      ? [
          { key: 'all', name: 'All events', count: allEvents, icon: <AuditOutlined aria-hidden /> },
          ...[...new Set([...Object.keys(auditCounts), ...(category !== 'all' ? [category] : [])])]
            .sort()
            .map((key) => ({
              key,
              name: categoryNames[key] || readable(key),
              count: auditCounts[key] || 0,
              icon: <FileTextOutlined aria-hidden />,
            })),
        ]
      : [
          {
            key: 'all',
            name: 'All users',
            count: users.length,
            icon: <TeamOutlined aria-hidden />,
          },
          ...(result.roles || []).map((item) => ({
            key: item.code,
            name: item.display_name,
            count: users.filter((account) => account.roles.includes(item.code)).length,
            icon: roleIcons[item.code],
          })),
        ];
  const reset = edit?.resetPassword;
  const hasPassword = !edit?.id || reset;

  return (
    <section className="workspace admin-workspace" aria-label="Administration">
      <div className="workspace-toolbar">
        <h1>{view === 'audit' ? 'Audit Logs' : view === 'system' ? 'System' : 'Users'}</h1>
        {view !== 'system' && (
          <Input
            className="document-search"
            aria-label={view === 'audit' ? 'Search audit logs' : 'Search users'}
            prefix={<SearchOutlined aria-hidden />}
            value={search}
            maxLength={240}
            onChange={(e) => {
              setSelectedKeys([]);
              setQuery({ q: e.target.value, page: 1 }, { replace: true });
            }}
            placeholder={
              view === 'audit' ? 'Event, actor or record ID' : 'Username or display name'
            }
            allowClear
          />
        )}
        <span className="toolbar-spacer" />
        <Space size={4}>
          {view === 'users' && selected.length > 0 && (
            <>
              <span className="admin-selected-count" role="status">
                {selected.length} selected
              </span>
              <IconButton
                label="Reset selected passwords"
                icon={<KeyOutlined aria-hidden />}
                disabled={working}
                onClick={() =>
                  openEditor(
                    {
                      targets: selected.map(({ id, version }) => ({ id, version })),
                      username: `${selected.length} users`,
                    },
                    true,
                  )
                }
              />
              {user.permissions.includes('users:delete') && (
                <IconButton
                  label="Delete selected users"
                  icon={<DeleteOutlined aria-hidden />}
                  danger
                  disabled={working}
                  onClick={() => confirmDelete(selected)}
                />
              )}
              <IconButton
                label="Clear selection"
                icon={<ClearOutlined aria-hidden />}
                disabled={working}
                onClick={() => setSelectedKeys([])}
              />
            </>
          )}
          {view === 'users' && (
            <Button
              type="primary"
              icon={<PlusOutlined aria-hidden />}
              disabled={working}
              onClick={() => openEditor()}
            >
              Create user
            </Button>
          )}
          <IconButton
            label="Refresh"
            icon={<ReloadOutlined aria-hidden />}
            loading={working}
            onClick={load}
          />
          {view !== 'system' && (
            <IconButton
              label="Clear filters"
              icon={<ClearOutlined aria-hidden />}
              disabled={working}
              onClick={() => {
                setSelectedKeys([]);
                setQuery({ q: '', role: 'all', category: 'all', page: 1 });
              }}
            />
          )}
        </Space>
      </div>
      {error && <Alert type="error" showIcon title={error} />}
      {view === 'system' ? (
        <div className="registry-table-region">
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
        </div>
      ) : (
        <>
          <Tabs
            className="worklist-tabs"
            activeKey={view === 'audit' ? category : role}
            onChange={(key) => {
              setSelectedKeys([]);
              setQuery({ [view === 'audit' ? 'category' : 'role']: key, page: 1 });
            }}
            items={tabs.map(({ key, name, count, icon }) => ({
              key,
              icon,
              label: (
                <Space size={6}>
                  <span>{name}</span>
                  <Badge count={count} showZero size="small" color="#667386" />
                </Space>
              ),
            }))}
          />
          <WorklistTable
            loading={working}
            rowSelection={
              view === 'users'
                ? {
                    selectedRowKeys: selectedKeys,
                    preserveSelectedRowKeys: true,
                    onChange: (keys) => setSelectedKeys(keys.slice(0, 100)),
                    getCheckboxProps: (account) => ({
                      disabled:
                        working ||
                        account.id === user.id ||
                        (selectedKeys.length >= 100 && !selectedKeys.includes(account.id)),
                      'aria-label': `Select ${account.username}`,
                    }),
                  }
                : undefined
            }
            dataSource={
              view === 'audit'
                ? result.logs
                : filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)
            }
            columns={view === 'audit' ? auditColumns : columns}
            scroll={{ x: view === 'audit' ? 1110 : 1204 }}
            totals={
              view === 'audit'
                ? [
                    {
                      label: 'events',
                      value: result.total || 0,
                      icon: <AuditOutlined aria-hidden />,
                    },
                  ]
                : [
                    { label: 'users', value: filtered.length, icon: <TeamOutlined aria-hidden /> },
                    {
                      label: 'active',
                      value: filtered.filter((account) => account.is_active).length,
                      icon: <CheckCircleOutlined aria-hidden />,
                    },
                    {
                      label: 'disabled',
                      value: filtered.filter((account) => !account.is_active).length,
                      icon: <StopOutlined aria-hidden />,
                    },
                  ]
            }
            onChange={(_pagination, _filters, next) => {
              if (view === 'users')
                setQuery({
                  sort: next.order ? next.columnKey : 'username',
                  direction: next.order === 'descend' ? 'desc' : 'asc',
                  page: 1,
                });
            }}
            pagination={{
              current: currentPage,
              pageSize,
              total: view === 'audit' ? result.total || 0 : filtered.length,
              onChange: (next, size) => setQuery({ page: pageSize === size ? next : 1, size }),
            }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    view === 'audit'
                      ? 'No audit events match this view.'
                      : 'No users match this role and search.'
                  }
                />
              ),
            }}
          />
        </>
      )}
      <Modal
        className="admin-user-modal"
        title={
          <Space>
            {reset ? <KeyOutlined aria-hidden /> : <UserOutlined aria-hidden />}
            <span>
              {reset
                ? `Reset password · ${edit.username}`
                : edit?.id
                  ? `Edit user · ${edit.username}`
                  : 'Create user'}
            </span>
          </Space>
        }
        open={!!edit}
        width={600}
        onCancel={closeEditor}
        onOk={() => form.submit()}
        okText={reset ? 'Reset password' : edit?.id ? 'Save changes' : 'Create user'}
        confirmLoading={working}
        cancelButtonProps={{ disabled: working }}
        maskClosable={false}
        destroyOnHidden
      >
        <p className="admin-modal-intro">
          {reset
            ? edit.targets
              ? `Reset ${edit.targets.length} selected accounts together. Existing sessions will be revoked. Set one shared temporary password, or generate a different password for each account.`
              : 'Revoke existing sessions and issue a new temporary password.'
            : edit?.id
              ? 'Update this account’s identity and access. Saving revokes its current sessions.'
              : 'Set up an account and choose the access it needs.'}
        </p>
        {formError && <Alert type="error" showIcon title={formError} />}
        <Form
          form={form}
          layout="vertical"
          onFinish={save}
          disabled={working}
          initialValues={{ passwordMode: 'auto' }}
        >
          {!reset && (
            <>
              <div className="admin-form-grid">
                {!edit?.id && (
                  <Form.Item
                    label="Username"
                    name="username"
                    rules={[
                      {
                        required: true,
                        pattern: /^[a-zA-Z0-9_.-]{3,64}$/,
                        message: 'Use 3–64 letters, digits, dots, dashes or underscores.',
                      },
                    ]}
                  >
                    <Input autoComplete="off" maxLength={64} placeholder="e.g. archive.operator" />
                  </Form.Item>
                )}
                <Form.Item
                  label="Display name"
                  name="displayName"
                  rules={[{ required: true, whitespace: true, max: 120 }]}
                >
                  <Input autoComplete="off" maxLength={120} placeholder="Full name" />
                </Form.Item>
              </div>
              <Form.Item
                label="Roles"
                name="roles"
                rules={[
                  { required: true, type: 'array', min: 1, message: 'Select at least one role.' },
                ]}
                extra="Administrators do not inherit capture access. Capture/QC and approval roles, including approval levels, must remain separate."
              >
                <Select
                  mode="multiple"
                  placeholder="Select roles"
                  options={result.roles?.map((item) => ({
                    value: item.code,
                    label: item.display_name,
                  }))}
                />
              </Form.Item>
            </>
          )}
          {hasPassword && (
            <div className="admin-password-section">
              <Form.Item label="Temporary password" name="passwordMode">
                <Radio.Group
                  optionType="button"
                  buttonStyle="solid"
                  options={[
                    { value: 'auto', label: 'Auto-generate' },
                    { value: 'manual', label: 'Set password' },
                  ]}
                  onChange={() => form.resetFields(['password', 'confirmPassword'])}
                />
              </Form.Item>
              {passwordMode === 'manual' ? (
                <div className="admin-form-grid">
                  <Form.Item
                    label="Password"
                    name="password"
                    preserve={false}
                    rules={[
                      {
                        required: true,
                        min: 12,
                        max: 256,
                        whitespace: true,
                        message: 'Use 12–256 characters.',
                      },
                    ]}
                  >
                    <Input.Password autoComplete="new-password" maxLength={256} />
                  </Form.Item>
                  <Form.Item
                    label="Confirm password"
                    name="confirmPassword"
                    preserve={false}
                    dependencies={['password']}
                    rules={[
                      { required: true, message: 'Confirm the temporary password.' },
                      ({ getFieldValue }) => ({
                        validator: (_, value) =>
                          value === getFieldValue('password')
                            ? Promise.resolve()
                            : Promise.reject(new Error('Passwords do not match.')),
                      }),
                    ]}
                  >
                    <Input.Password autoComplete="new-password" maxLength={256} />
                  </Form.Item>
                </div>
              ) : (
                <p className="admin-password-help">
                  {edit?.targets
                    ? 'A different secure random password for each account will be shown once after saving.'
                    : 'A secure random password will be shown once after saving.'}
                </p>
              )}
              <p className="admin-security-note">
                <LockOutlined aria-hidden /> The user must choose a new password at first sign-in.
              </p>
            </div>
          )}
        </Form>
      </Modal>
      <Modal
        title={
          <Space>
            <KeyOutlined aria-hidden />
            <span>Temporary credentials · shown once</span>
          </Space>
        }
        open={!!credentials}
        destroyOnHidden
        onCancel={() => setCredentials(null)}
        maskClosable={false}
        footer={
          <Button type="primary" onClick={() => setCredentials(null)}>
            I have saved these credentials
          </Button>
        }
      >
        <p className="admin-modal-intro">
          Store securely and share privately. The user must change this password on first sign-in.
        </p>
        {credentials?.map((credential) => (
          <Descriptions
            key={credential.username}
            className="admin-credentials"
            bordered
            column={1}
            items={[
              { key: 'username', label: 'Username', children: credential.username },
              {
                key: 'password',
                label: 'Temporary password',
                children: <code className="temporary-password">{credential.password}</code>,
              },
            ]}
          />
        ))}
      </Modal>
      <Modal
        title={
          <Space>
            <AuditOutlined aria-hidden />
            <span>Audit event details</span>
          </Space>
        }
        open={!!event}
        width={680}
        onCancel={() => setEvent(null)}
        footer={<Button onClick={() => setEvent(null)}>Close</Button>}
      >
        <Descriptions
          bordered
          column={1}
          items={[
            { key: 'action', label: 'Event', children: event?.action },
            { key: 'created_at', label: 'Time · WIB', children: dateTime(event?.created_at) },
            { key: 'actor', label: 'Actor', children: event?.actor || 'Bootstrap / system' },
            { key: 'entity_type', label: 'Record type', children: event?.entity_type },
            { key: 'entity_id', label: 'Record ID', children: event?.entity_id || '—' },
            { key: 'batch_id', label: 'Batch ID', children: event?.batch_id || '—' },
            {
              key: 'correlation_id',
              label: 'Correlation ID',
              children: event?.correlation_id || '—',
            },
            { key: 'id', label: 'Event ID', children: event?.id },
          ]}
        />
        <h3 className="admin-detail-heading">Event metadata</h3>
        <pre className="admin-event-metadata">{JSON.stringify(event?.metadata || {}, null, 2)}</pre>
      </Modal>
    </section>
  );
}
