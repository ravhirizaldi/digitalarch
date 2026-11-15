import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Badge,
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
  Tooltip,
} from 'antd';
import {
  CalendarOutlined,
  CheckCircleOutlined,
  ClearOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  ExclamationCircleOutlined,
  EyeOutlined,
  FileImageOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  HistoryOutlined,
  EnvironmentOutlined,
  PlusOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  QuestionCircleOutlined,
  RollbackOutlined,
  ScanOutlined,
  SearchOutlined,
  SendOutlined,
  TagsOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { api } from './api';
import { dateTime, IconButton } from './ui';
import WorklistTable, { BatchIdentity, BatchIdHeading, ColumnHeading } from './WorklistTable';
import { queryChoice, queryPage, useUrlState } from './useUrlState';

function readBatchState(params) {
  const size = Number(queryChoice(params, 'size', ['25', '50', '100']));
  const returned = params.get('status') === 'rework';
  const workflowView = ['capture_completed', 'submitted', 'completed'].includes(
    params.get('status'),
  );
  return {
    status: queryChoice(params, 'status', [
      'in_progress',
      'paused',
      'capture_completed',
      'rework',
      'submitted',
      'completed',
    ]),
    q: (params.get('q') || '').slice(0, 240),
    page: Math.min(queryPage(params, 'page'), Math.floor(1_000_000 / size) + 1),
    size,
    sort: queryChoice(
      params,
      'sort',
      [
        'batch_code',
        'physical_location',
        'page_count',
        'session_count',
        'assigned_operator',
        ...(returned
          ? ['returned_at']
          : ['updated_at', 'created_at', workflowView ? 'workflow_status' : 'status']),
      ],
      returned ? 'returned_at' : 'updated_at',
    ),
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
  'scan_session.cancel_requested': 'Scan cancellation requested',
  'scan_session.completed': 'Session completed',
  'scan_session.partial': 'Session partially captured',
  'scan_session.failed': 'Session failed',
  'scan_session.interrupted': 'Session interrupted',
  'page.rotated': 'Page rotated',
  'page.removed': 'Page removed',
  'page.restored': 'Page restored',
  'page.renamed': 'Page label updated',
  'qc.returned': 'Returned from QC',
  'qc.submitted': 'Sent to QC',
  'qc.resubmitted': 'Resubmitted to QC',
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

const workflowLabels = {
  capturing: 'Capturing',
  operator_preparation: 'Not sent to QC',
  preparing: 'Preparing OCR',
  qc_waiting: 'Waiting for QC',
  rework: 'Returned from QC',
  awaiting_approval_l1: 'Awaiting L1',
  awaiting_approval_l2: 'Awaiting L2',
  approved: 'Final approved',
  dropped: 'Dropped',
};

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
    returned: 0,
    activity: [],
  });
  const [query, setQuery] = useUrlState(readBatchState);
  const { status, q: search, page, size: pageSize, sort, direction, activity } = query;
  const tracking = ['submitted', 'completed'].includes(status);
  const workflowView = ['capture_completed', 'submitted', 'completed'].includes(status);
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
      title: <BatchIdHeading />,
      dataIndex: 'batch_code',
      width: 64,
      align: 'center',
      render: (value) => <BatchIdentity value={value} />,
    },
    {
      ...sortable('physical_location'),
      title: heading(<EnvironmentOutlined aria-hidden />, 'Location'),
      dataIndex: 'physical_location',
      width: 140,
      ellipsis: true,
      render: (value) => value || '—',
    },
    ...(status === 'rework'
      ? [
          {
            key: 'qc_return_reason',
            title: (
              <Tooltip title="QC return reason">
                <QuestionCircleOutlined aria-label="QC return reason" />
              </Tooltip>
            ),
            dataIndex: 'qc_return_reason',
            width: 44,
            align: 'center',
            render: (value) => (
              <Tooltip
                title={value || 'Review QC findings'}
                trigger={['hover', 'focus']}
                styles={{ body: { maxHeight: '50vh', overflowY: 'auto', whiteSpace: 'pre-wrap' } }}
              >
                <Button
                  type="text"
                  icon={<QuestionCircleOutlined aria-hidden />}
                  aria-label="QC return reason"
                />
              </Tooltip>
            ),
          },
        ]
      : []),
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
    ...(status === 'rework'
      ? [
          {
            ...sortable('returned_at'),
            title: heading(<RollbackOutlined aria-hidden />, 'Returned at'),
            dataIndex: 'qc_returned_at',
            width: 165,
            render: dateTime,
          },
        ]
      : [
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
            ...sortable(workflowView ? 'workflow_status' : 'status'),
            title: heading(<TagsOutlined aria-hidden />, workflowView ? 'Stage' : 'Status'),
            dataIndex: workflowView ? 'workflow_status' : 'status',
            width: workflowView ? 220 : 140,
            render: (value, batch) =>
              workflowView ? (
                <Tag
                  color={
                    value === 'operator_preparation'
                      ? 'error'
                      : value === 'approved'
                        ? 'success'
                        : 'processing'
                  }
                  icon={
                    value === 'operator_preparation' ? (
                      <ExclamationCircleOutlined aria-hidden />
                    ) : undefined
                  }
                  style={{ whiteSpace: 'normal' }}
                >
                  {value === 'qc_in_review'
                    ? batch.qc_claim_live
                      ? `QC — ${batch.qc_reviewer || 'In review'}`
                      : 'QC claim expired'
                    : value === 'operator_preparation' &&
                        ['queued', 'running', 'paused'].includes(batch.ocr_status)
                      ? `Not sent to QC · OCR ${batch.ocr_status}`
                      : workflowLabels[value] || value?.replaceAll('_', ' ') || 'Awaiting QC'}
                </Tag>
              ) : batch.workflow_status === 'rework' ? (
                <Tooltip title={batch.qc_return_reason || 'Review QC findings'}>
                  <Tag color="warning">Returned from QC</Tag>
                </Tooltip>
              ) : (
                batchStatus(value)
              ),
          },
        ]),
    {
      ...sortable('assigned_operator'),
      title: heading(<UserOutlined aria-hidden />, 'Operator'),
      dataIndex: 'assigned_operator',
      width: 130,
      ellipsis: true,
    },
    {
      title: heading(<FolderOpenOutlined aria-hidden />, 'Actions'),
      width: administrative ? 290 : tracking ? 64 : status === 'rework' ? 88 : 112,
      align: administrative ? 'left' : 'center',
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
        ) : tracking ? (
          <IconButton
            label="View document"
            icon={<EyeOutlined aria-hidden />}
            type="text"
            disabled={creating || loading}
            onClick={() => onDocument(batch.id)}
          />
        ) : (
          <Space size={4}>
            {onDocument && batch.workflow_status !== 'rework' && (
              <IconButton
                label="Prepare document"
                icon={<FileTextOutlined aria-hidden />}
                type="text"
                disabled={creating || loading}
                onClick={() => onDocument(batch.id)}
              />
            )}
            <IconButton
              type="text"
              disabled={creating || loading}
              onClick={() =>
                batch.workflow_status === 'rework' && onDocument
                  ? onDocument(batch.id)
                  : onOpen(batch)
              }
              label={
                batch.workflow_status === 'rework'
                  ? 'Continue rework'
                  : batch.status === 'capture_completed'
                    ? 'View details'
                    : 'Resume'
              }
              icon={
                batch.workflow_status === 'rework' ? (
                  <RollbackOutlined aria-hidden />
                ) : batch.status === 'capture_completed' ? (
                  <EyeOutlined aria-hidden />
                ) : (
                  <PlayCircleOutlined aria-hidden />
                )
              }
            />
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
                  <IconButton
                    label="Delete batch"
                    icon={<DeleteOutlined aria-hidden />}
                    type="text"
                    danger
                    disabled={creating || loading}
                  />
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
        className="worklist-tabs"
        activeKey={status}
        onChange={(value) => {
          const stageView = ['capture_completed', 'submitted', 'completed'].includes(value);
          setQuery({
            status: value,
            page: 1,
            sort:
              value === 'rework'
                ? 'returned_at'
                : sort === 'returned_at'
                  ? 'updated_at'
                  : ['status', 'workflow_status'].includes(sort)
                    ? stageView
                      ? 'workflow_status'
                      : 'status'
                    : sort,
            direction: value === 'rework' ? 'desc' : direction,
          });
        }}
        items={[
          'in_progress',
          'paused',
          'capture_completed',
          'rework',
          'submitted',
          'completed',
        ].map((key) => ({
          key,
          icon: {
            in_progress: <ScanOutlined aria-hidden />,
            paused: <PauseCircleOutlined aria-hidden />,
            capture_completed: <CheckCircleOutlined aria-hidden />,
            rework: <RollbackOutlined aria-hidden />,
            submitted: <SendOutlined aria-hidden />,
            completed: <HistoryOutlined aria-hidden />,
          }[key],
          label: (
            <Space size={6}>
              <span>
                {
                  {
                    in_progress: 'In Progress',
                    paused: 'Paused',
                    capture_completed: 'Capture Completed',
                    rework: 'Returned from QC',
                    submitted: 'Submitted / Tracking',
                    completed: 'Completed history',
                  }[key]
                }
              </span>
              <Badge
                count={result.counts?.[key] ?? 0}
                showZero
                size="small"
                color={key === 'rework' ? undefined : '#667386'}
              />
            </Space>
          ),
        }))}
      />
      <WorklistTable
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={result.batches}
        columns={columns}
        scroll={{
          x: status === 'rework' ? (administrative ? 1060 : 860) : administrative ? 1380 : 1180,
        }}
        totals={[
          { label: 'batches', value: result.total, icon: <FileTextOutlined aria-hidden /> },
          { label: 'pages', value: result.pages, icon: <FileImageOutlined aria-hidden /> },
          { label: 'sessions', value: result.sessions, icon: <ScanOutlined aria-hidden /> },
        ]}
        onChange={(_pagination, _filters, next) =>
          setQuery({
            sort: next.order ? next.columnKey : status === 'rework' ? 'returned_at' : 'updated_at',
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
              description={
                status === 'completed'
                  ? 'No published batches match this view. Work awaiting approval remains in Submitted / Tracking.'
                  : status === 'submitted'
                    ? 'No submitted batches match this view.'
                    : status === 'capture_completed'
                      ? 'No completed captures awaiting operator preparation or Send to QC.'
                      : status === 'rework'
                        ? 'No returned batches match this view.'
                        : 'No batches in this status. Create a batch or choose another tab.'
              }
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
