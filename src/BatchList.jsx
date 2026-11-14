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
import {
  CalendarOutlined,
  ClearOutlined,
  ClockCircleOutlined,
  FileImageOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  EnvironmentOutlined,
  PlusOutlined,
  ScanOutlined,
  SearchOutlined,
  TagsOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { api } from './api';
import { dateTime, IconButton } from './ui';
import WorklistTable, { BatchIdentity, ColumnHeading } from './WorklistTable';
import { queryChoice, queryPage, useUrlState } from './useUrlState';

function readBatchState(params) {
  const size = Number(queryChoice(params, 'size', ['25', '50', '100']));
  return {
    status: queryChoice(params, 'status', ['in_progress', 'paused', 'capture_completed']),
    q: (params.get('q') || '').slice(0, 240),
    page: Math.min(queryPage(params, 'page'), Math.floor(1_000_000 / size) + 1),
    size,
    sort: queryChoice(params, 'sort', [
      'updated_at',
      'created_at',
      'batch_code',
      'physical_location',
      'page_count',
      'session_count',
      'status',
      'assigned_operator',
    ]),
    direction: queryChoice(params, 'direction', ['desc', 'asc']),
    activity: params.get('activity') === '1',
  };
}

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
  onDocument,
  creating,
  userId,
  administrative = false,
}) {
  const [result, setResult] = useState({
    batches: [],
    total: 0,
    pages: 0,
    sessions: 0,
    activity: [],
  });
  const [query, setQuery] = useUrlState(readBatchState);
  const { status, q: search, page, size: pageSize, sort, direction, activity } = query;
  const requestId = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [operators, setOperators] = useState([]);
  const [assignments, setAssignments] = useState({});
  const load = useCallback(async () => {
    const request = ++requestId.current;
    setLoading(true);
    try {
      const next = await api(
        `/api/batches?${new URLSearchParams({ status, search, sort, direction, limit: String(pageSize), offset: String((page - 1) * pageSize) })}`,
      );
      if (request !== requestId.current) return;
      const lastPage = Math.max(1, Math.ceil(next.total / pageSize));
      if (page > lastPage) {
        setQuery({ page: lastPage }, { replace: true });
        return;
      }
      setResult(next);
      setError('');
      if (administrative) {
        const accounts = (await api('/api/admin/users')).users;
        if (request === requestId.current)
          setOperators(
            accounts.filter((user) => user.is_active && user.roles.includes('operator')),
          );
      }
    } catch (error) {
      if (request === requestId.current) setError(error.message);
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, [status, search, page, pageSize, sort, direction, administrative, setQuery]);
  useEffect(() => {
    const requests = requestId;
    const timer = setTimeout(load, 200);
    return () => {
      clearTimeout(timer);
      requests.current++;
    };
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
      if (result.batches.length === 1 && page > 1) setQuery({ page: page - 1 }, { replace: true });
      else await load();
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }
  const heading = (icon, text) => <ColumnHeading icon={icon}>{text}</ColumnHeading>;
  const sortable = (key) => ({
    key,
    sorter: true,
    sortOrder: sort === key ? (direction === 'asc' ? 'ascend' : 'descend') : null,
  });
  const columns = [
    {
      ...sortable('batch_code'),
      title: heading(<FileTextOutlined aria-hidden />, 'Batch'),
      dataIndex: 'batch_code',
      width: 270,
      render: (value) => <BatchIdentity value={value}>{value}</BatchIdentity>,
    },
    {
      ...sortable('physical_location'),
      title: heading(<EnvironmentOutlined aria-hidden />, 'Location'),
      dataIndex: 'physical_location',
      width: 140,
      ellipsis: true,
      render: (value) => value || '—',
    },
    {
      ...sortable('page_count'),
      title: heading(<FileImageOutlined aria-hidden />, 'Pages'),
      dataIndex: 'page_count',
      width: 88,
      align: 'right',
    },
    {
      ...sortable('session_count'),
      title: heading(<ScanOutlined aria-hidden />, 'Sessions'),
      dataIndex: 'session_count',
      width: 110,
      align: 'right',
    },
    {
      ...sortable('created_at'),
      title: heading(<CalendarOutlined aria-hidden />, 'Created'),
      dataIndex: 'created_at',
      width: 150,
      render: dateTime,
    },
    {
      ...sortable('updated_at'),
      title: heading(<ClockCircleOutlined aria-hidden />, 'Activity'),
      dataIndex: 'updated_at',
      width: 165,
      render: dateTime,
    },
    {
      ...sortable('status'),
      title: heading(<TagsOutlined aria-hidden />, 'Status'),
      dataIndex: 'status',
      width: 140,
      render: batchStatus,
    },
    {
      ...sortable('assigned_operator'),
      title: heading(<UserOutlined aria-hidden />, 'Operator'),
      dataIndex: 'assigned_operator',
      width: 130,
      ellipsis: true,
    },
    {
      title: heading(<FolderOpenOutlined aria-hidden />, 'Actions'),
      width: administrative ? 290 : 240,
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
            {onDocument && (
              <Button
                type="link"
                disabled={creating || loading}
                onClick={() => onDocument(batch.id)}
              >
                {batch.workflow_status === 'rework' ? 'QC findings' : 'Metadata / QC'}
              </Button>
            )}
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
      <div className="workspace-toolbar worklist-filters">
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
          maxLength={240}
          allowClear
          onChange={(event) => {
            setQuery({ q: event.target.value, page: 1 }, { replace: true });
          }}
          onPressEnter={load}
        />
        <span className="toolbar-spacer" />
        <Button icon={<SearchOutlined aria-hidden />} loading={loading} onClick={load}>
          Search
        </Button>
        <IconButton
          label="Clear filters"
          icon={<ClearOutlined aria-hidden />}
          onClick={() =>
            setQuery({
              q: '',
              status: 'in_progress',
              sort: 'updated_at',
              direction: 'desc',
              page: 1,
            })
          }
        />
      </div>
      {error && <Alert type="error" showIcon title={error} />}
      <Tabs
        activeKey={status}
        onChange={(value) => {
          setQuery({ status: value, page: 1 });
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
      <WorklistTable
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={result.batches}
        columns={columns}
        scroll={{ x: administrative ? 1500 : 1400 }}
        totals={[
          { label: 'batches', value: result.total, icon: <FileTextOutlined aria-hidden /> },
          { label: 'pages', value: result.pages, icon: <FileImageOutlined aria-hidden /> },
          { label: 'sessions', value: result.sessions, icon: <ScanOutlined aria-hidden /> },
        ]}
        onChange={(_pagination, _filters, next) =>
          setQuery({
            sort: next.order ? next.columnKey : 'updated_at',
            direction: next.order === 'ascend' ? 'asc' : 'desc',
            page: 1,
          })
        }
        pagination={{
          current: page,
          pageSize,
          total: result.total,
          onChange: (next, size) => setQuery({ page: pageSize === size ? next : 1, size }),
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
      {home && (
        <section className="recent-activity" aria-label="Recent activity">
          <Collapse
            size="small"
            activeKey={activity ? ['activity'] : []}
            onChange={(keys) =>
              setQuery({ activity: keys.includes('activity') }, { replace: true })
            }
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
                        title: heading(<TagsOutlined aria-hidden />, 'Event'),
                        dataIndex: 'action',
                        render: (action) =>
                          activityLabels[action] ||
                          action.replaceAll('.', ' ').replaceAll('_', ' '),
                      },
                      {
                        title: heading(<ClockCircleOutlined aria-hidden />, 'Time · WIB'),
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
