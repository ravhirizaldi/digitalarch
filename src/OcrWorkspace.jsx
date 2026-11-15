import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Descriptions,
  Empty,
  Input,
  Popconfirm,
  Progress,
  Select,
  Space,
  Splitter,
  Table,
  Tag,
  Tabs,
} from 'antd';
import {
  ArrowLeftOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  ClearOutlined,
  ClockCircleOutlined,
  EnvironmentOutlined,
  ExclamationCircleOutlined,
  EyeOutlined,
  FileImageOutlined,
  FileTextOutlined,
  FilterOutlined,
  PercentageOutlined,
  ReloadOutlined,
  SearchOutlined,
  SyncOutlined,
  TagsOutlined,
} from '@ant-design/icons';
import { api } from './api';
import { dateTime, IconButton } from './ui';
import WorklistTable, {
  BatchIdentity,
  BatchIdHeading,
  ColumnHeading,
  useTableHeight,
} from './WorklistTable';
import { queryChoice, queryPage, useUrlState } from './useUrlState';
import PageViewer from './PageViewer';
import MetadataPanel from './MetadataPanel';
import { pageName } from './pageLabels';

const labels = {
  queued: 'Queued',
  running: 'Running',
  processing: 'Processing',
  paused: 'Paused',
  completed: 'Completed',
  completed_with_errors: 'Completed with errors',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
const statusTag = (status) => (
  <Tag
    color={
      status === 'completed'
        ? 'success'
        : ['failed', 'completed_with_errors'].includes(status)
          ? 'error'
          : ['running', 'processing'].includes(status)
            ? 'processing'
            : 'default'
    }
  >
    {labels[status] || status}
  </Tag>
);
const percentage = (job) =>
  Math.floor(((job.processed_pages + job.failed_pages) * 100) / job.total_pages);

function readOcrListState(params) {
  const size = Number(queryChoice(params, 'size', ['25', '50', '100']));
  return {
    status: queryChoice(params, 'status', [
      '',
      ...Object.keys(labels).filter((value) => value !== 'processing'),
    ]),
    q: (params.get('q') || '').slice(0, 240),
    sort: queryChoice(params, 'sort', [
      'created_at',
      'batch_code',
      'physical_location',
      'total_pages',
      'processed_pages',
      'failed_pages',
      'progress',
      'status',
    ]),
    direction: queryChoice(params, 'direction', ['desc', 'asc']),
    page: Math.min(queryPage(params, 'page'), Math.floor(1_000_000 / size) + 1),
    size,
  };
}

function OcrJobList({ onOpen }) {
  const [query, setQuery] = useUrlState(readOcrListState);
  const { status, q: search, sort, direction, page, size } = query;
  const [data, setData] = useState({ jobs: [], total: 0, overview: {} });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    let fetching = false;
    async function load() {
      if (fetching) return;
      fetching = true;
      try {
        const next = await api(
          `/api/ocr/jobs?${new URLSearchParams({ status, search, sort, direction, limit: String(size), offset: String((page - 1) * size) })}`,
        );
        if (!alive) return;
        const lastPage = Math.max(1, Math.ceil(next.total / size));
        if (page > lastPage) {
          setQuery({ page: lastPage }, { replace: true });
          return;
        }
        setData(next);
        setError('');
      } catch (error) {
        if (alive) setError(error.message);
      } finally {
        fetching = false;
        if (alive) setLoading(false);
      }
    }
    setLoading(true);
    const pending = setTimeout(load, 200);
    const timer = setInterval(load, 2000);
    return () => {
      alive = false;
      clearTimeout(pending);
      clearInterval(timer);
    };
  }, [status, search, sort, direction, page, size, refresh, setQuery]);
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
      width: 150,
      ellipsis: true,
      render: (value) => value || '—',
    },
    {
      ...sortable('total_pages'),
      title: heading(<FileImageOutlined aria-hidden />, 'Pages'),
      dataIndex: 'total_pages',
      width: 88,
      align: 'right',
    },
    {
      ...sortable('processed_pages'),
      title: heading(<CheckCircleOutlined aria-hidden />, 'Processed'),
      dataIndex: 'processed_pages',
      width: 112,
      align: 'right',
    },
    {
      ...sortable('failed_pages'),
      title: heading(<ExclamationCircleOutlined aria-hidden />, 'Failed'),
      dataIndex: 'failed_pages',
      width: 88,
      align: 'right',
    },
    {
      ...sortable('progress'),
      title: heading(<PercentageOutlined aria-hidden />, 'Progress'),
      width: 130,
      render: (_, job) => (
        <Progress
          percent={percentage(job)}
          size="small"
          status={job.status === 'completed_with_errors' ? 'exception' : 'normal'}
        />
      ),
    },
    {
      ...sortable('status'),
      title: heading(<TagsOutlined aria-hidden />, 'Status'),
      dataIndex: 'status',
      width: 175,
      render: statusTag,
    },
    {
      ...sortable('created_at'),
      title: heading(<CalendarOutlined aria-hidden />, 'Created · WIB'),
      dataIndex: 'created_at',
      width: 180,
      render: dateTime,
    },
    {
      key: 'actions',
      title: heading(<EyeOutlined aria-hidden />, 'Action'),
      width: 64,
      align: 'center',
      render: (_, job) => (
        <IconButton
          label="Open OCR job"
          icon={<EyeOutlined aria-hidden />}
          type="text"
          onClick={() => onOpen(job.id)}
        />
      ),
    },
  ];
  return (
    <section className="workspace" aria-label="OCR Processing">
      <div className="workspace-toolbar worklist-filters">
        <h1>OCR Processing</h1>
        <Input
          className="document-search"
          aria-label="Search OCR jobs"
          prefix={<SearchOutlined aria-hidden />}
          placeholder="Batch code or physical location"
          maxLength={240}
          allowClear
          value={search}
          onChange={(event) => setQuery({ q: event.target.value, page: 1 }, { replace: true })}
          onPressEnter={() => setRefresh((value) => value + 1)}
        />
        <Select
          aria-label="Filter OCR status"
          prefix={<FilterOutlined aria-hidden />}
          value={status}
          className="ocr-status-filter"
          classNames={{ popup: { root: 'worklist-filter-popup' } }}
          options={[
            { value: '', label: 'All statuses' },
            ...Object.entries(labels)
              .filter(([value]) => value !== 'processing')
              .map(([value, label]) => ({ value, label })),
          ]}
          onChange={(value) => setQuery({ status: value, page: 1 })}
        />
        <span className="toolbar-spacer" />
        <Button
          icon={<SearchOutlined aria-hidden />}
          loading={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Search
        </Button>
        <IconButton
          label="Clear filters"
          icon={<ClearOutlined aria-hidden />}
          onClick={() =>
            setQuery({ q: '', status: '', sort: 'created_at', direction: 'desc', page: 1 })
          }
        />
        <IconButton
          label="Refresh OCR jobs"
          icon={<ReloadOutlined aria-hidden />}
          loading={loading}
          onClick={() => setRefresh((value) => value + 1)}
        />
      </div>
      {error && <Alert type="error" title={error} showIcon />}
      <dl className="ocr-overview" aria-label="OCR overview">
        {[
          ['total', 'Total jobs', <FileTextOutlined key="total" aria-hidden />],
          ['queued', 'Queued', <ClockCircleOutlined key="queued" aria-hidden />],
          ['running', 'Running', <SyncOutlined key="running" aria-hidden />],
          ['completed', 'Completed', <CheckCircleOutlined key="completed" aria-hidden />],
          ['errors', 'With errors', <ExclamationCircleOutlined key="errors" aria-hidden />],
        ].map(([key, label, icon]) => (
          <div key={key}>
            <dt>{heading(icon, label)}</dt>
            <dd>{data.overview?.[key] || 0}</dd>
          </div>
        ))}
      </dl>
      <WorklistTable
        loading={loading}
        dataSource={data.jobs}
        columns={columns}
        scroll={{ x: 1150 }}
        totals={[
          { label: 'jobs', value: data.total, icon: <FileTextOutlined aria-hidden /> },
          { label: 'pages', value: data.pages, icon: <FileImageOutlined aria-hidden /> },
          { label: 'processed', value: data.processed, icon: <CheckCircleOutlined aria-hidden /> },
          { label: 'failed', value: data.failed, icon: <ExclamationCircleOutlined aria-hidden /> },
        ]}
        onChange={(_, __, next) =>
          setQuery({
            sort: next.order ? next.columnKey : 'created_at',
            direction: next.order === 'ascend' ? 'asc' : 'desc',
            page: 1,
          })
        }
        pagination={{
          current: page,
          pageSize: size,
          total: data.total,
          onChange: (value, pageSize) =>
            setQuery({ page: pageSize === size ? value : 1, size: pageSize }),
        }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                status || search
                  ? 'No OCR jobs match this view.'
                  : 'No OCR jobs. Complete a batch capture to queue OCR.'
              }
            />
          ),
        }}
      />
    </section>
  );
}

export default function OcrWorkspace(props) {
  return props.jobId ? (
    <OcrJobDetail key={props.jobId} {...props} />
  ) : (
    <OcrJobList onOpen={props.onOpen} />
  );
}

function OcrJobDetail({
  user,
  jobId,
  onOpen,
  onSettings,
  metadataDirty,
  onMetadataDirty,
  onOpenDocument,
  onStatusChange,
}) {
  const [selected, setSelected] = useState(null);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState({ pages: [] });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [region, height] = useTableHeight();
  useEffect(() => {
    let alive = true;
    let fetching = false;
    async function load() {
      if (fetching) return;
      fetching = true;
      try {
        const next = await Promise.all([
          api(`/api/ocr/jobs/${jobId}`),
          api(`/api/ocr/jobs/${jobId}/pages?offset=${(page - 1) * 25}`),
        ]).then(([job, pages]) => ({ ...job, ...pages }));
        if (alive) {
          setData(next);
          setError('');
        }
      } catch (error) {
        if (alive) setError(error.message);
      } finally {
        fetching = false;
        if (alive) setLoading(false);
      }
    }
    setLoading(true);
    load();
    const timer = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [jobId, page, refresh]);
  const job = data.job?.id === jobId ? data.job : null;
  useEffect(() => {
    if (job) {
      onStatusChange({
        jobId: job.id,
        text: `${job.processed_pages} / ${job.total_pages} processed · ${job.failed_pages} failed · ${job.session_count} scan ${job.session_count === 1 ? 'session' : 'sessions'}${job.current_page ? ` · Processing page ${job.current_page}` : ''}`,
        percent: percentage(job),
        status: job.status,
      });
    }
    return () => onStatusChange(null);
  }, [job, onStatusChange]);
  const pages = job ? data.pages || [] : [];
  const current = pages.find((item) => item.page_id === selected) || pages[0];
  const defaults = data.defaults;
  const nextConfig = defaults?.processing_config;
  const canManage =
    job &&
    ![
      'preparing',
      'qc_waiting',
      'qc_in_review',
      'awaiting_approval_l1',
      'awaiting_approval_l2',
      'approved',
      'dropped',
    ].includes(job.workflow_status) &&
    user.permissions.includes('ocr:manage') &&
    (job.assigned_operator_id === user.id || user.permissions.includes('ocr:manage_all'));
  async function control(action) {
    if (
      action === 'reprocess' &&
      metadataDirty &&
      !window.confirm('Discard unsaved metadata edits?')
    )
      return;
    setWorking(true);
    try {
      const result = await api(`/api/ocr/jobs/${job.id}/${action}`, {
        version: job.version,
      });
      if (action === 'reprocess') {
        open(result.job.id, true);
        return;
      }
      setData((value) => ({ ...value, ...result }));
      setRefresh((value) => value + 1);
    } catch (error) {
      setError(error.message);
    } finally {
      setWorking(false);
    }
  }
  function open(id, discardApproved = false) {
    if (!discardApproved && metadataDirty && !window.confirm('Discard unsaved metadata edits?'))
      return;
    onOpen(id);
    setPage(1);
    setSelected(null);
  }
  const columns = [
    {
      title: <ColumnHeading icon={<FileImageOutlined aria-hidden />}>Page</ColumnHeading>,
      key: 'page',
      render: (_, row) => (
        <div className="ocr-page-list-item">
          <span title={pageName(row)}>{pageName(row)}</span>
          <Space size={[0, 4]} wrap>
            {statusTag(row.status)}
            {row.is_stale && <Tag>Stale revision</Tag>}
          </Space>
        </div>
      ),
    },
  ];
  return (
    <section className="workspace" aria-label="OCR Processing">
      <div className="workspace-toolbar">
        <Button icon={<ArrowLeftOutlined aria-hidden />} onClick={() => open(null)}>
          All jobs
        </Button>
        <h1>{job?.batch_code || 'OCR job'}</h1>
        {job && statusTag(job.status)}
        <span className="toolbar-spacer" />
        {job && (
          <Button
            type="primary"
            icon={<FileTextOutlined aria-hidden />}
            disabled={working}
            onClick={() => onOpenDocument(job.batch_id)}
          >
            Open document
          </Button>
        )}
        {canManage && (
          <Space wrap>
            {['queued', 'running'].includes(job.status) && (
              <Button disabled={working} onClick={() => control('pause')}>
                Pause
              </Button>
            )}
            {job.status === 'paused' && (
              <Button disabled={working} onClick={() => control('resume')}>
                Resume
              </Button>
            )}
            {['failed', 'completed_with_errors'].includes(job.status) && (
              <Button disabled={working} onClick={() => control('retry-failed')}>
                Retry failed pages
              </Button>
            )}
            {['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(job.status) && (
              <>
                {user.permissions.includes('settings:read') && (
                  <Button disabled={working} onClick={onSettings}>
                    OCR settings
                  </Button>
                )}
                <Popconfirm
                  title="Reprocess with global defaults?"
                  description="The current global settings will be saved to a new run. This result and original PNGs are preserved."
                  okText="Reprocess"
                  onConfirm={() => control('reprocess')}
                >
                  <Button disabled={working || !nextConfig}>Reprocess</Button>
                </Popconfirm>
              </>
            )}
            {job.status === 'queued' && (
              <Popconfirm
                title="Cancel queued OCR?"
                description="Already extracted text will be retained. This job cannot be resumed after cancellation."
                okText="Cancel OCR"
                cancelText="Keep job"
                okButtonProps={{ danger: true }}
                onConfirm={() => control('cancel')}
              >
                <Button danger disabled={working}>
                  Cancel job
                </Button>
              </Popconfirm>
            )}
          </Space>
        )}
        <Button
          icon={<ReloadOutlined aria-hidden />}
          loading={loading}
          disabled={working}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh
        </Button>
      </div>
      {error && <Alert type="error" title={error} showIcon />}
      {job?.last_error && <Alert type="warning" title={job.last_error} showIcon />}
      <div className="ocr-inspection-body">
        <div className="registry-table-region" ref={region}>
          <Table
            className="batch-table"
            style={{ '--batch-table-body-height': `${height}px` }}
            size="small"
            tableLayout="fixed"
            rowKey="page_id"
            loading={loading}
            dataSource={pages}
            columns={columns}
            scroll={{ y: height }}
            rowSelection={{
              type: 'radio',
              selectedRowKeys: current ? [current.page_id] : [],
              onChange: (keys) => setSelected(keys[0]),
              columnTitle: '',
              columnWidth: 32,
              getCheckboxProps: (row) => ({
                'aria-label': `Inspect ${pageName(row)}`,
              }),
            }}
            pagination={{
              current: page,
              pageSize: 25,
              simple: true,
              total: job?.total_pages || 0,
              showSizeChanger: false,
              onChange: (value) => {
                setPage(value);
                setSelected(null);
              },
            }}
            locale={{
              emptyText: (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No page results." />
              ),
            }}
          />
        </div>
        {jobId && (
          <Splitter className="workstation-split ocr-comparison">
            <Splitter.Panel defaultSize="52%" min={320}>
              <section className="panel preview-panel">
                <div className="panel-heading">
                  <h2>
                    {current
                      ? `${pageName(current)} · Session ${current.session_number}`
                      : 'Source page'}
                  </h2>
                </div>
                <PageViewer
                  image={
                    current
                      ? {
                          imageId: `${jobId}:${current.page_id}`,
                          width: current.width_px,
                          height: current.height_px,
                        }
                      : null
                  }
                  label="OCR source document"
                  rotation={current?.rotation_degrees || 0}
                  previewUrl={current && `/api/ocr/jobs/${jobId}/pages/${current.page_id}/preview`}
                  originalUrl={current && `/api/ocr/jobs/${jobId}/pages/${current.page_id}/image`}
                />
              </section>
            </Splitter.Panel>
            <Splitter.Panel min={300}>
              <section className="ocr-text-panel" aria-label="Page OCR result">
                <Tabs
                  className="ocr-result-tabs"
                  defaultActiveKey="text"
                  items={[
                    {
                      key: 'text',
                      label: 'Recognized text',
                      forceRender: true,
                      children: (
                        <>
                          {current?.is_stale && (
                            <Alert
                              type="warning"
                              showIcon
                              title="Historical revision. This text is not current."
                            />
                          )}
                          {current?.error_message && (
                            <Alert
                              type="error"
                              showIcon
                              title={current.error_message}
                              description={current.error_code}
                            />
                          )}
                          {current && (
                            <div className="ocr-page-meta">
                              {current.processed_at
                                ? dateTime(current.processed_at)
                                : 'Not processed'}
                              {current.processing_ms != null
                                ? ` · ${current.processing_ms} ms`
                                : ''}
                            </div>
                          )}
                          <pre
                            className="ocr-extracted-text"
                            tabIndex={0}
                            aria-label="Extracted text"
                          >
                            {current?.extracted_text ||
                              (current?.status === 'completed'
                                ? 'No text recognized.'
                                : 'Extracted text will appear after this page is processed.')}
                          </pre>
                        </>
                      ),
                    },
                    {
                      key: 'metadata',
                      label: 'Run metadata history',
                      children: job && (
                        <MetadataPanel
                          key={job.id}
                          job={job}
                          canManage={false}
                          onDirtyChange={onMetadataDirty}
                          onSource={(source) => {
                            setPage(
                              Math.floor((source.pageOffset ?? source.pageNumber - 1) / 25) + 1,
                            );
                            setSelected(source.pageId);
                          }}
                        />
                      ),
                    },
                    {
                      key: 'details',
                      label: 'Job details',
                      children: job && (
                        <div className="ocr-job-details">
                          <Descriptions
                            size="small"
                            column={1}
                            items={[
                              {
                                key: 'sessions',
                                label: 'Scan sessions',
                                children: job.session_count,
                              },
                              { key: 'pages', label: 'Total pages', children: job.total_pages },
                              {
                                key: 'completed',
                                label: 'Completed pages',
                                children: job.processed_pages,
                              },
                              { key: 'failed', label: 'Failed pages', children: job.failed_pages },
                              {
                                key: 'current',
                                label: 'Processing page',
                                children: job.current_page || '—',
                              },
                              {
                                key: 'progress',
                                label: 'Progress',
                                children: `${percentage(job)}%`,
                              },
                              {
                                key: 'engine',
                                label: 'Engine',
                                children: `${job.engine}${job.engine_version ? ` ${job.engine_version}` : ' · awaiting initialization'}`,
                              },
                              { key: 'language', label: 'Language', children: job.language },
                              {
                                key: 'threads',
                                label: 'CPU threads',
                                children:
                                  job.processing_config?.engine === 'paddleocr'
                                    ? job.processing_config.cpuThreads || 1
                                    : 'SDK managed',
                              },
                              {
                                key: 'profile',
                                label: 'Profile',
                                children: job.processing_config?.profile || 'legacy',
                              },
                              {
                                key: 'psm',
                                label: 'Segmentation',
                                children:
                                  job.processing_config?.engine === 'paddleocr'
                                    ? 'Learned text detection'
                                    : `PSM ${job.processing_config?.psm || 3}`,
                              },
                              {
                                key: 'model',
                                label: 'Model',
                                children:
                                  job.processing_config?.model ||
                                  (job.processing_config?.quality === 'fast' ? 'Fast' : 'Best'),
                              },
                              {
                                key: 'started',
                                label: 'Started · WIB',
                                children: job.started_at ? dateTime(job.started_at) : '—',
                              },
                              {
                                key: 'finished',
                                label: 'Completed · WIB',
                                children: job.completed_at ? dateTime(job.completed_at) : '—',
                              },
                            ]}
                          />
                        </div>
                      ),
                    },
                  ]}
                />
              </section>
            </Splitter.Panel>
          </Splitter>
        )}
      </div>
    </section>
  );
}
