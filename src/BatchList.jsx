import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Collapse,
  Empty,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
} from 'antd';
import { PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { api } from './api';
import { dateTime } from './ui';

const activityLabels = {
  'batch.created': 'Batch created',
  'batch.resumed': 'Batch resumed',
  'batch.paused': 'Batch paused',
  'batch.capture_completed': 'Capture completed',
  'batch.location_updated': 'Location updated',
  'batch.cancelled': 'Batch cancelled',
  'batch.reassigned': 'Batch reassigned',
  'batch.deleted': 'Batch deleted',
  'scan_session.started': 'Session started',
  'scan_session.completed': 'Session completed',
  'scan_session.partial': 'Session partially captured',
  'scan_session.failed': 'Session failed',
  'scan_session.interrupted': 'Session interrupted',
  'page.rotated': 'Page rotated',
  'page.removed': 'Page removed',
  'page.restored': 'Page restored',
};

export function useTableHeight() {
  const region = useRef(null);
  const [height, setHeight] = useState(250);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setHeight(Math.max(80, entry.contentRect.height - 110)),
    );
    if (region.current) observer.observe(region.current);
    return () => observer.disconnect();
  }, []);
  return [region, height];
}
export const batchStatus = (value) => (
  <Tag
    color={
      value === 'capture_completed' ? 'success' : value === 'in_progress' ? 'processing' : 'default'
    }
  >
    {value.replaceAll('_', ' ')}
  </Tag>
);

export default function BatchList({
  home,
  onNew,
  onOpen,
  creating,
  userId,
  administrative = false,
}) {
  const [result, setResult] = useState({ batches: [], total: 0, activity: [] });
  const [status, setStatus] = useState('in_progress');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [operators, setOperators] = useState([]);
  const [assignments, setAssignments] = useState({});
  const [region, height] = useTableHeight();
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setResult(
        await api(
          `/api/batches?status=${status}&search=${encodeURIComponent(search)}&offset=${(page - 1) * 25}`,
        ),
      );
      setError('');
      if (administrative)
        setOperators(
          (await api('/api/admin/users')).users.filter(
            (user) => user.is_active && user.roles.includes('operator'),
          ),
        );
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }, [status, search, page, administrative]);
  useEffect(() => {
    const timer = setTimeout(load, 200);
    return () => clearTimeout(timer);
  }, [load]);
  async function reassign(batch) {
    setLoading(true);
    try {
      await api(`/api/batches/${batch.id}/reassign`, {
        version: batch.version,
        operatorId: assignments[batch.id],
      });
      await load();
    } catch (error) {
      setError(error.message);
      setLoading(false);
    }
  }
  async function deleteBatch(batch) {
    setLoading(true);
    try {
      await api(`/api/batches/${batch.id}/delete`, { version: batch.version });
      setResult((current) => ({
        ...current,
        batches: current.batches.filter((item) => item.id !== batch.id),
        total: Math.max(0, current.total - 1),
      }));
      if (result.batches.length === 1 && page > 1) setPage(page - 1);
      else await load();
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }
  const columns = [
    { title: 'Batch ID', dataIndex: 'batch_code', width: 230, ellipsis: true },
    {
      title: 'Physical location',
      dataIndex: 'physical_location',
      width: 140,
      ellipsis: true,
      render: (value) => value || '—',
    },
    {
      title: 'Pages',
      dataIndex: 'page_count',
      width: 70,
      align: 'right',
      sorter: (a, b) => a.page_count - b.page_count,
    },
    { title: 'Sessions', dataIndex: 'session_count', width: 80, align: 'right' },
    {
      title: 'Last activity · WIB',
      dataIndex: 'updated_at',
      width: 165,
      render: dateTime,
      sorter: (a, b) => a.updated_at.localeCompare(b.updated_at),
    },
    { title: 'Status', dataIndex: 'status', width: 120, render: batchStatus },
    { title: 'Assigned operator', dataIndex: 'assigned_operator', width: 130, ellipsis: true },
    {
      title: 'Action',
      width: administrative ? 290 : 160,
      fixed: 'right',
      render: (_, batch) =>
        administrative ? (
          <Space>
            <Select
              aria-label={`Assign ${batch.batch_code}`}
              className="assignment-select"
              disabled={!['paused', 'in_progress'].includes(batch.status) || loading}
              value={assignments[batch.id] || batch.assigned_operator_id}
              options={operators.map((user) => ({ value: user.id, label: user.display_name }))}
              onChange={(value) => setAssignments((current) => ({ ...current, [batch.id]: value }))}
            />
            <Button disabled={!assignments[batch.id] || loading} onClick={() => reassign(batch)}>
              Reassign
            </Button>
          </Space>
        ) : (
          <Space size={4}>
            <Button type="link" disabled={creating || loading} onClick={() => onOpen(batch)}>
              {batch.status === 'capture_completed' ? 'View details' : 'Resume'}
            </Button>
            {batch.assigned_operator_id === userId &&
              ['in_progress', 'paused'].includes(batch.status) && (
                <Popconfirm
                  title={`Delete ${batch.batch_code}?`}
                  description="The batch leaves your lists. Original files and audit history are retained."
                  okText="Delete batch"
                  cancelText="Keep batch"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => deleteBatch(batch)}
                >
                  <Button type="link" danger disabled={creating || loading}>
                    Delete
                  </Button>
                </Popconfirm>
              )}
          </Space>
        ),
    },
  ];
  return (
    <section
      className="workspace"
      aria-label={administrative ? 'Batch assignments' : home ? 'Capture Workspace' : 'My Batches'}
    >
      <div className="workspace-toolbar">
        <h1>{administrative ? 'Batch assignments' : home ? 'Capture Workspace' : 'My Batches'}</h1>
        {!administrative && (
          <Button
            type="primary"
            icon={<PlusOutlined aria-hidden />}
            loading={creating}
            onClick={onNew}
          >
            Scan New Batch
          </Button>
        )}
        <Input
          className="document-search"
          aria-label="Search batches"
          prefix={<SearchOutlined />}
          placeholder="Batch code or physical location"
          value={search}
          allowClear
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
        />
        <span className="toolbar-spacer" />
        <Button icon={<ReloadOutlined aria-hidden />} loading={loading} onClick={load}>
          Refresh
        </Button>
      </div>
      {error && <Alert type="error" showIcon title={error} />}
      <Tabs
        activeKey={status}
        onChange={(value) => {
          setStatus(value);
          setPage(1);
        }}
        items={['in_progress', 'paused', 'capture_completed'].map((key) => ({
          key,
          label: {
            in_progress: 'In Progress',
            paused: 'Paused',
            capture_completed: 'Capture Completed',
          }[key],
        }))}
      />
      <div className="registry-table-region" ref={region}>
        <Table
          className="batch-table"
          style={{ '--batch-table-body-height': `${height}px` }}
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={result.batches}
          columns={columns}
          scroll={{ x: administrative ? 1300 : 1100, y: height }}
          pagination={{
            current: page,
            pageSize: 25,
            total: result.total,
            showSizeChanger: false,
            onChange: setPage,
          }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="No batches in this status. Create a batch or choose another tab."
              />
            ),
          }}
        />
      </div>
      {home && (
        <section className="recent-activity" aria-label="Recent activity">
          <Collapse
            size="small"
            items={[
              {
                key: 'activity',
                label: 'Recent activity',
                children: (
                  <Table
                    size="small"
                    rowKey={(_, index) => index}
                    pagination={false}
                    dataSource={result.activity}
                    columns={[
                      {
                        title: 'Event',
                        dataIndex: 'action',
                        render: (action) =>
                          activityLabels[action] ||
                          action.replaceAll('.', ' ').replaceAll('_', ' '),
                      },
                      {
                        title: 'Time · WIB',
                        dataIndex: 'created_at',
                        render: dateTime,
                        width: 180,
                      },
                    ]}
                    scroll={{ y: 160 }}
                    locale={{ emptyText: 'No recent activity' }}
                  />
                ),
              },
            ]}
          />
        </section>
      )}
    </section>
  );
}
