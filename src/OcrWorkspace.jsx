import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Collapse,
  Descriptions,
  Empty,
  Popconfirm,
  Progress,
  Select,
  Space,
  Splitter,
  Table,
  Tag,
  Tabs,
} from 'antd';
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons';
import { api } from './api';
import { dateTime } from './ui';
import { useTableHeight } from './WorklistTable';
import PageViewer from './PageViewer';
import MetadataPanel from './MetadataPanel';

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

export default function OcrWorkspace({
  user,
  jobId,
  onOpen,
  onSettings,
  metadataDirty,
  onMetadataDirty,
  onOpenDocument,
}) {
  const [selected, setSelected] = useState(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState({ jobs: [], pages: [], total: 0, overview: {} });
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
        const next = jobId
          ? await Promise.all([
              api(`/api/ocr/jobs/${jobId}`),
              api(`/api/ocr/jobs/${jobId}/pages?offset=${(page - 1) * 25}`),
            ]).then(([job, pages]) => ({ ...job, ...pages }))
          : await api(`/api/ocr/jobs?status=${status}&offset=${(page - 1) * 25}`);
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
  }, [jobId, page, status, refresh]);
  const job = data.job?.id === jobId ? data.job : null;
  const pages = job ? data.pages || [] : [];
  const current = pages.find((item) => item.page_id === selected) || pages[0];
  const defaults = data.defaults;
  const nextConfig = defaults?.processing_config;
  const canManage =
    job &&
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
  const columns = jobId
    ? [
        { title: 'Page', dataIndex: 'page_number', width: 60 },
        {
          title: 'Status',
          dataIndex: 'status',
          render: (_, row) => (
            <Space size={0}>
              {statusTag(row.status)}
              {row.is_stale && <Tag>Stale revision</Tag>}
            </Space>
          ),
        },
      ]
    : [
        { title: 'Batch ID', dataIndex: 'batch_code', width: 240, ellipsis: true },
        { title: 'Pages', dataIndex: 'total_pages', width: 65, align: 'right' },
        { title: 'Processed', dataIndex: 'processed_pages', width: 85, align: 'right' },
        { title: 'Failed', dataIndex: 'failed_pages', width: 65, align: 'right' },
        {
          title: 'Progress',
          width: 125,
          render: (_, job) => (
            <Progress
              percent={percentage(job)}
              size="small"
              status={job.status === 'completed_with_errors' ? 'exception' : 'normal'}
            />
          ),
        },
        { title: 'Status', dataIndex: 'status', width: 175, render: statusTag },
        { title: 'Created · WIB', dataIndex: 'created_at', width: 165, render: dateTime },
        {
          title: 'Action',
          width: 85,
          render: (_, row) => (
            <Button type="link" onClick={() => open(row.id)}>
              Details
            </Button>
          ),
        },
      ];
  return (
    <section className="workspace" aria-label="OCR Processing">
      <div className="workspace-toolbar">
        {jobId && (
          <Button icon={<ArrowLeftOutlined aria-hidden />} onClick={() => open(null)}>
            All jobs
          </Button>
        )}
        <h1>{jobId ? job?.batch_code || 'OCR job' : 'OCR Processing'}</h1>
        {job && (
          <Button onClick={() => onOpenDocument(job.batch_id)}>Document metadata / QC</Button>
        )}
        {job && statusTag(job.status)}
        {!jobId && (
          <Select
            aria-label="Filter OCR status"
            value={status}
            className="ocr-status-filter"
            options={[
              { value: '', label: 'All statuses' },
              ...Object.entries(labels)
                .filter(([value]) => value !== 'processing')
                .map(([value, label]) => ({ value, label })),
            ]}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
          />
        )}
        <span className="toolbar-spacer" />
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
      {!jobId && (
        <dl className="ocr-overview" aria-label="OCR overview">
          {[
            ['total', 'Total jobs'],
            ['queued', 'Queued'],
            ['running', 'Running'],
            ['completed', 'Completed'],
            ['errors', 'With errors'],
          ].map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{data.overview?.[key] || 0}</dd>
            </div>
          ))}
        </dl>
      )}
      {job && (
        <div className="ocr-progress-strip">
          <span>
            {job.processed_pages} / {job.total_pages} processed
          </span>
          <span>{job.failed_pages} failed</span>
          <span>
            {job.session_count} scan {job.session_count === 1 ? 'session' : 'sessions'}
          </span>
          {job.current_page && <span>Processing page {job.current_page}</span>}
          <Progress percent={percentage(job)} size="small" />
        </div>
      )}
      {job && (
        <Collapse
          size="small"
          items={[
            {
              key: 'details',
              label: 'Job details',
              children: (
                <Descriptions
                  size="small"
                  column={4}
                  items={[
                    { key: 'sessions', label: 'Scan sessions', children: job.session_count },
                    { key: 'pages', label: 'Total pages', children: job.total_pages },
                    { key: 'completed', label: 'Completed pages', children: job.processed_pages },
                    { key: 'failed', label: 'Failed pages', children: job.failed_pages },
                    { key: 'current', label: 'Processing page', children: job.current_page || '—' },
                    { key: 'progress', label: 'Progress', children: `${percentage(job)}%` },
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
              ),
            },
          ]}
        />
      )}
      <div className={jobId ? 'ocr-inspection-body' : 'workspace'}>
        <div className="registry-table-region" ref={region}>
          <Table
            className="batch-table"
            style={{ '--batch-table-body-height': `${height}px` }}
            size="small"
            rowKey={jobId ? 'page_id' : 'id'}
            loading={loading}
            dataSource={jobId ? pages : data.jobs || []}
            columns={columns}
            scroll={{ x: jobId ? undefined : 1040, y: height }}
            rowSelection={
              jobId
                ? {
                    type: 'radio',
                    selectedRowKeys: current ? [current.page_id] : [],
                    onChange: (keys) => setSelected(keys[0]),
                    columnTitle: '',
                    columnWidth: 32,
                    getCheckboxProps: (row) => ({
                      'aria-label': `Inspect page ${row.page_number}`,
                    }),
                  }
                : undefined
            }
            pagination={{
              current: page,
              pageSize: 25,
              total: jobId ? job?.total_pages || 0 : data.total,
              showSizeChanger: false,
              onChange: (value) => {
                setPage(value);
                setSelected(null);
              },
            }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    jobId
                      ? 'No page results.'
                      : 'No OCR jobs. Complete a batch capture to queue OCR.'
                  }
                />
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
                      ? `Page ${current.page_number} · Session ${current.session_number}`
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
