import React, { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Empty, Input, Select, Space, Tag } from 'antd';
import { CheckOutlined, CloseOutlined, ReloadOutlined } from '@ant-design/icons';
import { api } from './api';
import { dateTime, IconButton } from './ui';
import WorklistTable from './WorklistTable';
import { queryChoice, queryPage, useUrlState } from './useUrlState';

const read = (params) => ({
  status: queryChoice(params, 'status', ['pending', 'approved', 'rejected']),
  q: (params.get('q') || '').slice(0, 240),
  page: queryPage(params),
});
export default function ViewerRegistrations() {
  const { modal } = App.useApp();
  const [query, setQuery] = useUrlState(read);
  const [requests, setRequests] = useState([]),
    [error, setError] = useState(''),
    [working, setWorking] = useState(false);
  const load = useCallback(async () => {
    setWorking(true);
    try {
      setRequests((await api(`/api/admin/viewer-registrations?status=${query.status}`)).requests);
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }, [query.status]);
  useEffect(() => {
    load();
  }, [load]);
  function decide(account, action) {
    modal.confirm({
      title: `${action === 'approve' ? 'Approve' : 'Reject'} ${account.username}?`,
      content:
        action === 'approve'
          ? 'This account will be able to view and download all published documents. It receives no operational permissions.'
          : 'The account will not be able to access documents. Its username and decision history are retained.',
      okText: action === 'approve' ? 'Approve viewer' : 'Reject request',
      okButtonProps: { danger: action === 'reject' },
      async onOk() {
        setWorking(true);
        try {
          await api(`/api/admin/viewer-registrations/${account.id}`, {
            version: account.version,
            action,
          });
          await load();
        } catch (e) {
          setError(e.message);
          throw e;
        } finally {
          setWorking(false);
        }
      },
    });
  }
  const rows = requests.filter((r) =>
    `${r.display_name} ${r.username}`.toLowerCase().includes(query.q.toLowerCase()),
  );
  return (
    <section className="workspace" aria-label="Viewer registrations">
      <div className="workspace-toolbar">
        <h1>Viewer registrations</h1>
        <Input
          className="document-search"
          aria-label="Search viewer registrations"
          placeholder="Name or username"
          value={query.q}
          maxLength={240}
          onChange={(e) => setQuery({ q: e.target.value, page: 1 }, { replace: true })}
        />
        <Select
          aria-label="Registration status"
          value={query.status}
          onChange={(status) => setQuery({ status, page: 1 })}
          options={['pending', 'approved', 'rejected'].map((value) => ({
            value,
            label: value[0].toUpperCase() + value.slice(1),
          }))}
        />
        <span className="toolbar-spacer" />
        <IconButton
          label="Refresh registrations"
          icon={<ReloadOutlined aria-hidden />}
          disabled={working}
          onClick={load}
        />
      </div>
      {error && <Alert type="error" showIcon title={error} />}
      <WorklistTable
        loading={working}
        columns={[
          {
            title: 'Applicant',
            dataIndex: 'display_name',
            render: (value, row) => (
              <div className="admin-cell">
                <strong>{value}</strong>
                <span>{row.username}</span>
              </div>
            ),
          },
          { title: 'Requested', dataIndex: 'created_at', render: dateTime },
          {
            title: 'Status',
            dataIndex: 'viewer_registration_status',
            render: (value) => (
              <Tag
                color={
                  value === 'approved' ? 'success' : value === 'rejected' ? 'error' : 'processing'
                }
              >
                {value}
              </Tag>
            ),
          },
          {
            title: 'Actions',
            width: 210,
            render: (_, row) =>
              row.viewer_registration_status === 'pending' ? (
                <Space>
                  <Button
                    icon={<CheckOutlined aria-hidden />}
                    disabled={working}
                    onClick={() => decide(row, 'approve')}
                  >
                    Approve
                  </Button>
                  <IconButton
                    label={`Reject ${row.username}`}
                    icon={<CloseOutlined aria-hidden />}
                    danger
                    disabled={working}
                    onClick={() => decide(row, 'reject')}
                  />
                </Space>
              ) : null,
          },
        ]}
        dataSource={rows.slice((query.page - 1) * 25, query.page * 25)}
        totals={[{ label: 'requests', value: rows.length }]}
        pagination={{
          current: query.page,
          pageSize: 25,
          total: rows.length,
          showSizeChanger: false,
          onChange: (page) => setQuery({ page }),
        }}
        locale={{ emptyText: <Empty description="No viewer registrations match this view." /> }}
      />
    </section>
  );
}
