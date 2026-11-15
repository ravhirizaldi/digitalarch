import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Drawer, Empty, Input, Select, Tag } from 'antd';
import {
  AuditOutlined,
  CalendarOutlined,
  ClearOutlined,
  EyeOutlined,
  FileImageOutlined,
  FileTextOutlined,
  FilterOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { api } from './api';
import { dateTime, IconButton } from './ui';
import WorklistTable, { BatchIdentity, BatchIdHeading, ColumnHeading } from './WorklistTable';
import { queryChoice, queryPage, useUrlState } from './useUrlState';

export const workflowNames = {
  capturing: 'Capturing',
  operator_preparation: 'Not sent to QC',
  preparing: 'Preparing OCR',
  qc_waiting: 'Waiting for QC',
  qc_in_review: 'QC in review',
  rework: 'Returned to operator',
  awaiting_approval_l1: 'Awaiting L1',
  awaiting_approval_l2: 'Awaiting L2',
  approved: 'Published',
  dropped: 'Dropped',
};
export const workflowTag = (value) => (
  <Tag
    color={
      value === 'approved'
        ? 'success'
        : ['dropped', 'operator_preparation'].includes(value)
          ? 'error'
          : value === 'rework'
            ? 'warning'
            : 'processing'
    }
  >
    {workflowNames[value] || value}
  </Tag>
);
function readState(params) {
  const size = Number(queryChoice(params, 'size', ['25', '50', '100']));
  return {
    q: (params.get('q') || '').slice(0, 240),
    type: (params.get('type') || '').slice(0, 240),
    number: (params.get('number') || '').slice(0, 240),
    location: (params.get('location') || '').slice(0, 240),
    operator: params.get('operator') || '',
    reviewer: params.get('reviewer') || '',
    authority: params.get('authority') || '',
    from: params.get('from') || '',
    to: params.get('to') || '',
    ocr: queryChoice(params, 'ocr', [
      '',
      'not_queued',
      'queued',
      'running',
      'paused',
      'completed',
      'completed_with_errors',
      'failed',
      'cancelled',
    ]),
    metadata: queryChoice(params, 'metadata', [
      '',
      'not_extracted',
      'needs_review',
      'manually_corrected',
      'verified',
    ]),
    sort: queryChoice(params, 'sort', [
      'updated_at',
      'created_at',
      'published_at',
      'title',
      'workflow_status',
      'page_count',
    ]),
    direction: queryChoice(params, 'direction', ['desc', 'asc']),
    page: Math.min(queryPage(params, 'page'), Math.floor(1_000_000 / size) + 1),
    size,
    filters: params.get('filters') === '1',
  };
}
export default function Documents({ user, approvals = false, onOpen }) {
  const [query, setQuery] = useUrlState(readState);
  const [data, setData] = useState({ records: [], people: [] });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const requests = useRef(0);
  const level = user.permissions.includes('approval_l1:review') ? 1 : 2;
  const { q, page, size, filters, ...rest } = query;
  const parameters = new URLSearchParams({
    ...rest,
    search: q,
    view: approvals ? `l${level}` : 'published',
    limit: String(size),
    offset: String((page - 1) * size),
  }).toString();
  const load = useCallback(async () => {
    const request = ++requests.current;
    setLoading(true);
    try {
      const next = await api(`/api/records?${parameters}`);
      if (request === requests.current) {
        setData(next);
        setError('');
      }
    } catch (error) {
      if (request === requests.current) setError(error.message);
    } finally {
      if (request === requests.current) setLoading(false);
    }
  }, [parameters]);
  useEffect(() => {
    load();
  }, [load]);
  const update = (patch) => setQuery({ ...patch, page: 1 }, { replace: true });
  const clearFilters = () =>
    setQuery({
      q: '',
      type: '',
      number: '',
      location: '',
      operator: '',
      reviewer: '',
      authority: '',
      from: '',
      to: '',
      ocr: '',
      metadata: '',
      page: 1,
    });
  const sortable = (key) => ({
    key,
    sorter: true,
    sortOrder: query.sort === key ? (query.direction === 'asc' ? 'ascend' : 'descend') : null,
  });
  const people = data.people.map(({ id, display_name }) => ({ value: id, label: display_name }));
  const columns = [
    {
      title: <BatchIdHeading />,
      dataIndex: 'batch_code',
      width: 44,
      align: 'center',
      render: (value) => <BatchIdentity value={value} />,
    },
    {
      ...sortable('title'),
      title: <ColumnHeading icon={<FileTextOutlined aria-hidden />}>Document</ColumnHeading>,
      dataIndex: 'title',
      width: 250,
      render: (value, row) => (
        <div className="worklist-document-cell">
          <Button
            type="link"
            className="worklist-document-link"
            title={value || 'Untitled document'}
            onClick={() => onOpen(row.id)}
          >
            {value || 'Untitled document'}
          </Button>
          <span>{row.archive_number || 'Number not set'}</span>
          <span>{row.document_type || 'Type not set'}</span>
        </div>
      ),
    },
    {
      ...sortable('workflow_status'),
      title: <ColumnHeading icon={<AuditOutlined aria-hidden />}>Stage</ColumnHeading>,
      dataIndex: 'workflow_status',
      width: 160,
      render: workflowTag,
    },
    {
      ...sortable('page_count'),
      title: <ColumnHeading icon={<FileImageOutlined aria-hidden />}>Pages</ColumnHeading>,
      dataIndex: 'page_count',
      width: 88,
      align: 'right',
    },
    { title: 'Operator', dataIndex: 'operator', width: 145, ellipsis: true },
    { title: 'QC officer', dataIndex: 'reviewer', width: 145, ellipsis: true },
    {
      title: 'L2 authority',
      dataIndex: 'authority',
      width: 145,
      ellipsis: true,
      render: (value) => value || '—',
    },
    { title: 'Location', dataIndex: 'physical_location', width: 155, ellipsis: true },
    {
      ...sortable('created_at'),
      title: <ColumnHeading icon={<CalendarOutlined aria-hidden />}>Created · WIB</ColumnHeading>,
      dataIndex: 'created_at',
      width: 175,
      render: dateTime,
    },
    {
      ...sortable('published_at'),
      title: 'Published · WIB',
      dataIndex: 'published_at',
      width: 175,
      render: (value) => (value ? dateTime(value) : '—'),
    },
    {
      title: <EyeOutlined aria-label="Open" />,
      width: 56,
      align: 'center',
      fixed: 'right',
      render: (_, row) => (
        <IconButton
          label="View document"
          icon={<EyeOutlined aria-hidden />}
          onClick={() => onOpen(row.id)}
        />
      ),
    },
  ];
  return (
    <section className="workspace" aria-label={approvals ? 'Approval queue' : 'Documents'}>
      <div className="workspace-toolbar">
        <h1>{approvals ? `L${level} approvals` : 'Documents'}</h1>
        <Input
          className="document-search"
          aria-label="Search documents"
          prefix={<SearchOutlined aria-hidden />}
          placeholder="Batch, title, number, type or location"
          value={q}
          maxLength={240}
          allowClear
          onChange={(e) => update({ q: e.target.value })}
        />
        <span className="toolbar-spacer" />
        <IconButton
          label="Advanced filters"
          icon={<FilterOutlined aria-hidden />}
          aria-expanded={filters}
          aria-haspopup="dialog"
          onClick={() => setQuery({ filters: !filters }, { replace: true })}
        />
        <IconButton
          label="Refresh"
          icon={<ReloadOutlined aria-hidden />}
          loading={loading}
          onClick={load}
        />
        <IconButton
          label="Clear filters"
          icon={<ClearOutlined aria-hidden />}
          onClick={clearFilters}
        />
      </div>
      {error && <Alert type="error" showIcon title={error} />}
      {!approvals && <p className="qc-panel-caption">Published documents only.</p>}
      {approvals && (
        <p className="qc-panel-caption">
          {data.settings?.[`l${level}_label`]} ·{' '}
          {level === 1
            ? 'Review the locked QC revision, then select L2 or publish under the batch’s L1-only policy.'
            : 'Only documents assigned to you by L1 appear here.'}
        </p>
      )}
      <Drawer
        title="Advanced filters"
        open={filters}
        onClose={() => setQuery({ filters: false }, { replace: true })}
        size={360}
        extra={
          <IconButton
            label="Clear filters"
            icon={<ClearOutlined aria-hidden />}
            onClick={clearFilters}
          />
        }
      >
        <div className="records-filter-grid">
          {[
            ['type', 'Document type'],
            ['number', 'Document number'],
            ['location', 'Physical location'],
          ].map(([key, label]) => (
            <label key={key}>
              {label}
              <Input
                aria-label={label}
                value={query[key]}
                maxLength={240}
                allowClear
                onChange={(e) => update({ [key]: e.target.value })}
              />
            </label>
          ))}
          {[
            ['operator', 'Operator'],
            ['reviewer', 'QC officer'],
            ['authority', 'L2 authority'],
          ].map(([key, label]) => (
            <label key={key}>
              {label}
              <Select
                aria-label={label}
                value={query[key] || undefined}
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder="All officers"
                options={people}
                onChange={(value) => update({ [key]: value || '' })}
              />
            </label>
          ))}
          {[
            ['from', 'Created from · WIB'],
            ['to', 'Created through · WIB'],
          ].map(([key, label]) => (
            <label key={key}>
              {label}
              <Input
                aria-label={label}
                type="date"
                value={query[key]}
                onChange={(e) => update({ [key]: e.target.value })}
              />
            </label>
          ))}
          <label>
            OCR status
            <Select
              aria-label="OCR status"
              value={query.ocr}
              onChange={(ocr) => update({ ocr })}
              options={[
                '',
                'not_queued',
                'queued',
                'running',
                'paused',
                'completed',
                'completed_with_errors',
                'failed',
                'cancelled',
              ].map((value) => ({
                value,
                label: value ? value.replaceAll('_', ' ') : 'All OCR states',
              }))}
            />
          </label>
          <label>
            Metadata status
            <Select
              aria-label="Metadata status"
              value={query.metadata}
              onChange={(metadata) => update({ metadata })}
              options={['', 'not_extracted', 'needs_review', 'manually_corrected', 'verified'].map(
                (value) => ({
                  value,
                  label: value ? value.replaceAll('_', ' ') : 'All metadata states',
                }),
              )}
            />
          </label>
        </div>
      </Drawer>
      <WorklistTable
        loading={loading}
        columns={columns}
        dataSource={data.records}
        scroll={{ x: 1640 }}
        totals={[
          { label: 'documents', value: data.total || 0, icon: <FileTextOutlined aria-hidden /> },
        ]}
        pagination={{
          current: page,
          pageSize: size,
          total: data.total || 0,
          onChange: (next, nextSize) =>
            setQuery({ page: nextSize === size ? next : 1, size: nextSize }),
        }}
        onChange={(_pagination, _filters, next) =>
          setQuery({
            sort: next.order ? next.columnKey : 'updated_at',
            direction: next.order === 'ascend' ? 'asc' : 'desc',
            page: 1,
          })
        }
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                approvals
                  ? 'No documents await your approval.'
                  : 'No published documents match your filters.'
              }
            />
          ),
        }}
      />
    </section>
  );
}
