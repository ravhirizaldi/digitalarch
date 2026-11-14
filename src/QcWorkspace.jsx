import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Pagination,
  Popconfirm,
  Select,
  Space,
  Spin,
  Splitter,
  Tabs,
  Tag,
} from 'antd';
import {
  ArrowDownOutlined,
  ArrowLeftOutlined,
  ArrowUpOutlined,
  CalendarOutlined,
  ClearOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  EyeOutlined,
  FileImageOutlined,
  FileSearchOutlined,
  FileTextOutlined,
  FilterOutlined,
  LeftOutlined,
  ReloadOutlined,
  RightOutlined,
  RotateLeftOutlined,
  RotateRightOutlined,
  SafetyCertificateOutlined,
  ScanOutlined,
  SearchOutlined,
  TagsOutlined,
  UndoOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { api } from './api';
import { dateTime, IconButton, Thumbnail } from './ui';
import WorklistTable, { BatchIdentity, BatchIdHeading, ColumnHeading } from './WorklistTable';
import PageViewer from './PageViewer';
import MetadataPanel, { metadataTypeLabels } from './MetadataPanel';
import { queryChoice, queryPage, queryZoom, useUrlState } from './useUrlState';

function readQueueState(params) {
  const size = Number(queryChoice(params, 'size', ['25', '50', '100']));
  return {
    tab: queryChoice(params, 'tab', ['all', 'mine']),
    status: queryChoice(params, 'status', [
      'waiting',
      'all',
      'review',
      'returned',
      'passed',
      'ocr_incomplete',
    ]),
    q: (params.get('q') || '').slice(0, 240),
    metadata: queryChoice(params, 'metadata', [
      '',
      'pending',
      'not_extracted',
      'needs_review',
      'manually_corrected',
      'verified',
    ]),
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
    sort: queryChoice(params, 'sort', [
      'updated_at',
      'created_at',
      'title',
      'page_count',
      'session_count',
      'metadata_status',
      'ocr_status',
      'workflow_status',
      'assigned_operator',
    ]),
    direction: queryChoice(params, 'direction', ['desc', 'asc']),
    page: Math.min(queryPage(params, 'page'), Math.floor(1_000_000 / size) + 1),
    size,
  };
}

function readDocumentState(params) {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const id = (key) => (uuid.test(params.get(key) || '') ? params.get(key) : null);
  return {
    tab: queryChoice(params, 'tab', ['metadata', 'ocr', 'properties', 'issues', 'history']),
    page: id('page'),
    rail: queryPage(params, 'rail'),
    session: id('session') || 'all',
    excluded: params.get('excluded') === '1',
    original: params.get('original') === '1',
    revision: id('revision'),
    zoom: queryZoom(params),
    pixels: params.get('pixels') === '1',
    fullscreen: params.get('fullscreen') === '1',
    processing: params.get('processing') === '1',
    machine: params.get('machine') === '1',
    policy: params.get('policy') === '1',
    evidence: (params.get('evidence') || '')
      .split(',')
      .filter((value) => uuid.test(value))
      .slice(0, 200)
      .join(','),
    field: id('field'),
  };
}

const categories = [
  'blurred_page',
  'cropped_page',
  'incorrect_orientation',
  'incorrect_order',
  'missing_page',
  'duplicate_page',
  'suspected_blank_page',
  'unreadable_text',
  'ocr_error',
  'metadata_error',
  'incomplete_document',
  'other',
];
const label = (value) => value?.replaceAll('_', ' ') || '—';
const activityLabels = {
  'qc.claimed': 'Document claimed',
  'qc.released': 'Claim released',
  'qc.reassigned': 'Claim released for reassignment',
  'qc.ready': 'Ready for QC',
  'qc.saved': 'Review draft saved',
  'qc.returned': 'Returned to operator',
  'qc.passed': 'QC passed',
  'qc.finding_updated': 'Finding updated',
  'metadata.updated': 'Metadata saved',
  'metadata.extracted': 'Metadata suggestions refreshed',
  'metadata.verified': 'Metadata verified',
  'metadata.adopted': 'Historical metadata retained',
  'metadata.policy_updated': 'Metadata policy updated',
  'ocr.text_corrected': 'OCR correction saved',
  'ocr.reprocessed': 'OCR reprocessing requested',
};

export function QcQueue({ onOpen }) {
  const queueRequest = useRef(0);
  const [data, setData] = useState({ batches: [], total: 0, pages: 0, sessions: 0, counts: {} });
  const [query, setQuery] = useUrlState(readQueueState);
  const {
    tab: queueTab,
    status: filter,
    q: searchTerm,
    metadata,
    ocr,
    sort,
    direction,
    page,
    size: pageSize,
  } = query;
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    const request = ++queueRequest.current;
    setLoading(true);
    try {
      const next = await api(
        `/api/qc/queue?${new URLSearchParams({ filter: queueTab === 'mine' ? 'mine' : filter, search: searchTerm, metadata, ocr, sort, direction, limit: String(pageSize), offset: String((page - 1) * pageSize) })}`,
      );
      if (request !== queueRequest.current) return;
      const lastPage = Math.max(1, Math.ceil(next.total / pageSize));
      if (page > lastPage) {
        setQuery({ page: lastPage }, { replace: true });
        return;
      }
      setData(next);
      setError('');
    } catch (e) {
      if (request === queueRequest.current) setError(e.message);
    } finally {
      if (request === queueRequest.current) setLoading(false);
    }
  }, [queueTab, filter, searchTerm, metadata, ocr, sort, direction, page, pageSize, setQuery]);
  useEffect(() => {
    const requests = queueRequest;
    const timer = setTimeout(load, 200);
    return () => {
      clearTimeout(timer);
      requests.current++;
    };
  }, [load]);
  useEffect(() => {
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);
  function submitSearch() {
    if (searchTerm.trim() === searchTerm && page === 1) load();
    else setQuery({ q: searchTerm.trim(), page: 1 });
  }
  const heading = (icon, text) => <ColumnHeading icon={icon}>{text}</ColumnHeading>;
  const sortable = (key) => ({
    key,
    sorter: true,
    sortOrder: sort === key ? (direction === 'asc' ? 'ascend' : 'descend') : null,
  });
  const statusLabels = {
    qc_waiting: 'Waiting',
    qc_in_review: 'In review',
    preparing: 'Preparing',
    rework: 'Returned',
    awaiting_approval_l1: 'QC passed',
    pending: 'Pending',
    not_extracted: 'Not extracted',
    needs_review: 'Needs review',
    manually_corrected: 'Corrected',
    verified: 'Verified',
    queued: 'Queued',
    running: 'Running',
    paused: 'Paused',
    completed: 'Complete',
    completed_with_errors: 'With errors',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };
  const status = (value) => (
    <Tag
      className="qc-queue-status"
      color={
        ['completed', 'verified', 'awaiting_approval_l1'].includes(value)
          ? 'success'
          : ['failed', 'completed_with_errors'].includes(value)
            ? 'error'
            : ['qc_in_review', 'running'].includes(value)
              ? 'processing'
              : ['rework', 'needs_review'].includes(value)
                ? 'warning'
                : 'default'
      }
    >
      {statusLabels[value] || (value ? label(value) : 'Not queued')}
    </Tag>
  );
  return (
    <section className="workspace qc-queue" aria-label="QC Queue">
      <div className="qc-queue-heading">
        <h1>QC Queue</h1>
        <span className="qc-queue-overall">{data.counts.all ?? '—'} documents</span>
        <Tabs
          className="qc-queue-tabs"
          activeKey={queueTab}
          onChange={(key) => {
            queueRequest.current++;
            setData((current) => ({ ...current, batches: [], total: 0, pages: 0, sessions: 0 }));
            setLoading(true);
            setQuery({ tab: key, page: 1 });
          }}
          items={[
            {
              key: 'all',
              label: (
                <span className="qc-tab-label">
                  <FileSearchOutlined aria-hidden />
                  Shared QC queue
                </span>
              ),
            },
            {
              key: 'mine',
              label: (
                <span className="qc-tab-label">
                  <UserOutlined aria-hidden />
                  Claimed documents<span className="qc-tab-count">{data.counts.mine ?? '—'}</span>
                </span>
              ),
            },
          ]}
        />
      </div>
      <div className="workspace-toolbar worklist-filters qc-queue-filters">
        <Input
          className="qc-queue-search"
          aria-label="Search QC queue"
          prefix={<SearchOutlined aria-hidden />}
          placeholder="Search title, batch, number, location or operator"
          value={searchTerm}
          maxLength={240}
          onChange={(e) => setQuery({ q: e.target.value, page: 1 }, { replace: true })}
          onPressEnter={submitSearch}
          allowClear
        />
        {queueTab === 'all' && (
          <Select
            className="qc-view-filter"
            classNames={{ popup: { root: 'worklist-filter-popup' } }}
            aria-label="QC queue filter"
            prefix={<FilterOutlined aria-hidden />}
            value={filter}
            onChange={(value) => {
              setQuery({ status: value, page: 1 });
            }}
            options={[
              ['all', 'All QC documents'],
              ['waiting', 'Waiting for QC'],
              ['review', 'In review'],
              ['returned', 'Returned for rework'],
              ['passed', 'QC passed / history'],
              ['ocr_incomplete', 'OCR incomplete'],
            ].map(([value, label]) => ({
              value,
              label: `${label} (${data.counts[value] ?? '—'})`,
            }))}
          />
        )}
        <Select
          className="qc-metadata-filter"
          classNames={{ popup: { root: 'worklist-filter-popup' } }}
          aria-label="Filter metadata status"
          prefix={<TagsOutlined aria-hidden />}
          value={metadata}
          onChange={(value) => setQuery({ metadata: value, page: 1 })}
          options={[
            { value: '', label: 'All metadata states' },
            ...['not_extracted', 'needs_review', 'manually_corrected', 'verified', 'pending'].map(
              (value) => ({ value, label: statusLabels[value] }),
            ),
          ]}
        />
        <Select
          className="qc-ocr-filter"
          classNames={{ popup: { root: 'worklist-filter-popup' } }}
          aria-label="Filter OCR status"
          prefix={<ScanOutlined aria-hidden />}
          value={ocr}
          onChange={(value) => setQuery({ ocr: value, page: 1 })}
          options={[
            { value: '', label: 'All OCR states' },
            { value: 'not_queued', label: 'Not queued' },
            ...[
              'queued',
              'running',
              'paused',
              'completed',
              'completed_with_errors',
              'failed',
              'cancelled',
            ].map((value) => ({
              value,
              label:
                value === 'completed_with_errors' ? 'Completed with errors' : statusLabels[value],
            })),
          ]}
        />
        <Button
          type="primary"
          icon={<SearchOutlined aria-hidden />}
          onClick={submitSearch}
          loading={loading}
        >
          Search
        </Button>
        <IconButton
          label="Clear filters"
          icon={<ClearOutlined aria-hidden />}
          onClick={() =>
            setQuery({
              q: '',
              metadata: '',
              ocr: '',
              status: 'waiting',
              sort: 'updated_at',
              direction: 'desc',
              page: 1,
            })
          }
        />
      </div>
      {error && <Alert type="error" title={error} />}
      <WorklistTable
        rowKey="id"
        size="small"
        loading={loading}
        locale={{
          emptyText:
            queueTab === 'mine'
              ? 'No claimed documents. Claim a document from the shared QC queue to start a review.'
              : 'No documents match this queue view.',
        }}
        dataSource={data.batches}
        scroll={{ x: 1360 }}
        pagination={{
          current: page,
          pageSize,
          total: data.total,
          onChange: (next, size) => setQuery({ page: size === pageSize ? next : 1, size }),
        }}
        totals={[
          { label: 'documents', value: data.total, icon: <FileTextOutlined aria-hidden /> },
          { label: 'pages', value: data.pages, icon: <FileImageOutlined aria-hidden /> },
          { label: 'sessions', value: data.sessions, icon: <ScanOutlined aria-hidden /> },
        ]}
        onChange={(_pagination, _filters, next) =>
          setQuery({
            sort: next.order ? next.columnKey : 'updated_at',
            direction: next.order === 'ascend' ? 'asc' : 'desc',
            page: 1,
          })
        }
        columns={[
          {
            key: 'batch_code',
            title: <BatchIdHeading />,
            dataIndex: 'batch_code',
            width: 44,
            align: 'center',
            render: (value) => <BatchIdentity value={value} />,
          },
          {
            ...sortable('title'),
            title: heading(<FileTextOutlined aria-hidden />, 'Document'),
            dataIndex: 'title',
            width: 210,
            render: (value, row) => (
              <div className="worklist-document-cell">
                <Button
                  type="link"
                  className="worklist-document-link"
                  onClick={() => onOpen(row.id)}
                  title={value || 'Untitled document'}
                >
                  {value || 'Untitled document'}
                </Button>
                <span>{row.document_type || 'Type not set'}</span>
              </div>
            ),
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
            ...sortable('ocr_status'),
            title: heading(<FileSearchOutlined aria-hidden />, 'OCR'),
            dataIndex: 'ocr_status',
            width: 112,
            render: status,
          },
          {
            ...sortable('metadata_status'),
            title: heading(<TagsOutlined aria-hidden />, 'Metadata'),
            dataIndex: 'metadata_status',
            width: 124,
            render: status,
          },
          {
            ...sortable('workflow_status'),
            title: heading(<SafetyCertificateOutlined aria-hidden />, 'QC'),
            dataIndex: 'workflow_status',
            width: 112,
            render: status,
          },
          {
            ...sortable('assigned_operator'),
            title: heading(<UserOutlined aria-hidden />, 'Operator'),
            dataIndex: 'assigned_operator',
            width: 120,
            ellipsis: true,
          },
          {
            ...sortable('created_at'),
            title: heading(<CalendarOutlined aria-hidden />, 'Created'),
            dataIndex: 'created_at',
            width: 140,
            render: (value) => <span className="qc-queue-date">{dateTime(value)}</span>,
          },
          {
            ...sortable('updated_at'),
            title: heading(<ClockCircleOutlined aria-hidden />, 'Activity'),
            dataIndex: 'updated_at',
            width: 140,
            render: (value) => <span className="qc-queue-date">{dateTime(value)}</span>,
          },
          {
            key: 'open',
            title: heading(<EyeOutlined aria-hidden />, 'Open'),
            fixed: 'right',
            width: 72,
            render: (_, row) => (
              <IconButton
                label={queueTab === 'mine' ? 'Continue review' : 'Open'}
                icon={<EyeOutlined aria-hidden />}
                onClick={() => onOpen(row.id)}
              />
            ),
          },
        ]}
      />
    </section>
  );
}

export default function QcWorkspace({
  batchId,
  user,
  onBack,
  onCapture,
  onDirtyChange,
  onStatusChange,
}) {
  const lastInteraction = useRef(Date.now());
  const [data, setData] = useState(null);
  const [viewState, setViewState] = useUrlState(readDocumentState);
  const {
    tab,
    page: selected,
    rail: listPage,
    session,
    excluded: showExcluded,
    original,
    revision: revisionId,
  } = viewState;
  const [pageInfoData, setPageInfo] = useState(null);
  const pageRequest = useRef(0);
  const [sourceHighlight, setSourceHighlight] = useState(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [metadataDirty, setMetadataDirty] = useState(false);
  const [draft, setDraft] = useState(null);
  const [reviewDirty, setReviewDirty] = useState(false);
  const [textDraft, setTextDraft] = useState('');
  const [textDirty, setTextDirty] = useState(false);
  const [issue, setIssue] = useState(null);
  const [decision, setDecision] = useState(null);
  const [reason, setReason] = useState('');
  const [requiredMetadata, setRequiredMetadata] = useState([]);
  const can = (permission) => user.permissions.includes(permission);
  const canReview = user.permissions.includes('qc:review');
  const review = data?.reviews[0];
  const mine =
    data?.document.workflow_status === 'qc_in_review' &&
    review?.claimed_by === user.id &&
    new Date(review.claim_expires_at) > new Date();
  const operator = data?.batch.assigned_operator_id === user.id && can('batches:update');
  const editable =
    mine ||
    (operator &&
      ['capturing', 'preparing', 'qc_waiting', 'rework'].includes(data?.document.workflow_status));
  const dirty = metadataDirty || reviewDirty || textDirty;
  const load = useCallback(
    async (keepDraft = false, resumeClaim = false) => {
      let next = await api(`/api/qc/${batchId}`);
      if (
        resumeClaim &&
        canReview &&
        next.document.workflow_status === 'qc_in_review' &&
        next.reviews[0]?.claimed_by === user.id
      ) {
        await api(`/api/qc/${batchId}/claim`, { version: next.document.version });
        next = await api(`/api/qc/${batchId}`);
      }
      setData(next);
      if (!keepDraft) {
        setDraft(next.reviews[0] || null);
        setReviewDirty(false);
        setRequiredMetadata(next.document.required_metadata);
      }
      return next;
    },
    [batchId, user.id, canReview],
  );
  useEffect(() => {
    load(false, true).catch((e) => setError(e.message));
  }, [load]);
  useEffect(() => {
    if (data) {
      onStatusChange({
        batchId,
        text: `${data.pages.filter((p) => !p.is_excluded && !p.replacement_candidate).length} included pages · ${data.pages.filter((p) => p.review_status === 'reviewed' && p.reviewed_image_revision === p.image_revision).length} reviewed · ${data.findings.filter((f) => !['resolved', 'waived'].includes(f.status)).length} unresolved findings · Cycle ${data.document.review_cycle} · Revision ${data.document.revision}`,
      });
    }
    return () => onStatusChange(null);
  }, [data, batchId, onStatusChange]);
  const visible =
    data?.pages.filter(
      (p) =>
        !p.replacement_candidate &&
        (showExcluded || !p.is_excluded) &&
        (session === 'all' || p.scan_session_id === session),
    ) || [];
  const page = visible.find((p) => p.id === selected) || visible[0];
  const pageInfo = pageInfoData?.page.id === page?.id ? pageInfoData : null;
  const loadPage = useCallback(async () => {
    if (!page?.id) return;
    const request = ++pageRequest.current;
    const next = await api(`/api/qc/${batchId}/pages/${page.id}`);
    if (request !== pageRequest.current) return;
    setPageInfo(next);
    setTextDraft(next.ocr?.corrected_text ?? next.ocr?.extracted_text ?? '');
    setTextDirty(false);
  }, [batchId, page?.id]);
  useEffect(() => {
    const requests = pageRequest;
    setPageInfo(null);
    loadPage().catch((e) => setError(e.message));
    return () => {
      requests.current++;
    };
  }, [loadPage]);
  useEffect(() => {
    if (data && page && selected !== page.id)
      setViewState(
        { page: page.id, ...(selected ? { original: false, revision: null } : {}) },
        { replace: true },
      );
  }, [data, page, selected, setViewState]);
  useEffect(() => {
    if (data && session !== 'all' && !data.sessions.some((s) => s.id === session))
      setViewState({ session: 'all', rail: 1 }, { replace: true });
  }, [data, session, setViewState]);
  useEffect(() => {
    onDirtyChange(dirty);
    const warn = (e) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      onDirtyChange(false);
      window.removeEventListener('beforeunload', warn);
    };
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!mine) return;
    const timer = setInterval(
      async () => {
        if (document.hidden || Date.now() - lastInteraction.current > 25 * 60 * 1000) return;
        try {
          await api(`/api/qc/${batchId}/heartbeat`, { version: data.document.version });
          await load(true);
        } catch (e) {
          setError(e.message);
        }
      },
      5 * 60 * 1000,
    );
    return () => clearInterval(timer);
  }, [mine, batchId, data?.document.version, load]);
  async function action(name, body = {}) {
    if (reviewDirty && name !== 'save') {
      setError('Save Draft before making another review change.');
      return false;
    }
    setWorking(true);
    setError('');
    try {
      await api(`/api/qc/${batchId}/${name}`, { version: data.document.version, ...body });
      await load();
      await loadPage();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setWorking(false);
    }
  }
  function selectPage(id, patch = {}) {
    if (textDirty && !window.confirm('Discard unsaved OCR text correction?')) return false;
    const target = data.pages.find((p) => p.id === id);
    const nextSession =
      patch.session ?? (session === 'all' || target?.scan_session_id === session ? session : 'all');
    const excluded = patch.excluded ?? (showExcluded || !!target?.is_excluded);
    const pages = data.pages.filter(
      (p) =>
        !p.replacement_candidate &&
        (excluded || !p.is_excluded) &&
        (nextSession === 'all' || p.scan_session_id === nextSession),
    );
    setViewState({
      page: id,
      original: false,
      revision: null,
      session: nextSession,
      excluded,
      rail:
        Math.floor(
          Math.max(
            0,
            pages.findIndex((p) => p.id === id),
          ) / 40,
        ) + 1,
      ...patch,
    });
    setSourceHighlight(null);
    return true;
  }
  const index = visible.findIndex((p) => p.id === page?.id);
  useEffect(() => {
    const lastPage = Math.max(1, Math.ceil(visible.length / 40));
    if (data && listPage > lastPage) setViewState({ rail: lastPage }, { replace: true });
  }, [data, listPage, visible.length, setViewState]);
  function nextPage(delta) {
    const p = visible[index + delta];
    if (p) {
      selectPage(p.id);
    }
  }
  async function pageAction(operation, beforePageId) {
    if (mine) return action('page-edit', { pageId: page.id, action: operation, beforePageId });
    setWorking(true);
    setError('');
    try {
      if (operation === 'reorder')
        await api(`/api/batches/${batchId}/reorder`, {
          version: data.batch.version,
          pageId: page.id,
          beforePageId,
        });
      else
        await api(
          `/api/pages/${page.id}`,
          { version: data.batch.version, action: operation === 'exclude' ? 'remove' : operation },
          'PATCH',
        );
      await load();
      await loadPage();
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  function keyDown(e) {
    lastInteraction.current = Date.now();
    if (
      e.ctrlKey ||
      e.altKey ||
      e.metaKey ||
      /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) ||
      e.target.isContentEditable ||
      e.target.closest('.ant-select')
    )
      return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      nextPage(e.key === 'ArrowDown' ? 1 : -1);
    }
    if (mine && e.key.toLowerCase() === 'r' && page) {
      e.preventDefault();
      pageAction('rotate-right');
    }
    if (mine && e.key.toLowerCase() === 'm' && page) {
      e.preventDefault();
      action('page-review', { pageIds: [page.id], status: 'reviewed' });
    }
  }
  if (!data) return error ? <Alert type="error" title={error} /> : <Spin />;
  const captureMutable =
    operator && ['capturing', 'rework'].includes(data.document.workflow_status);
  const pageMutable = mine || captureMutable;
  const ocr = pageInfo?.ocr;
  const processing = ocr?.processing_config;
  const notes = (
    <div className="qc-checklist">
      <div className="qc-section-heading">
        <h3>Review checklist</h3>
      </div>
      <p className="qc-policy-note">
        Required policy fields:{' '}
        {data.document.required_metadata
          .map((type) => metadataTypeLabels[type] || type)
          .join(', ') || 'None configured (QC must still review metadata).'}
      </p>
      {can('qc:configure') &&
        !['qc_in_review', 'awaiting_approval_l1'].includes(data.document.workflow_status) && (
          <details
            className="qc-disclosure"
            open={viewState.policy}
            onToggle={(e) => {
              if (e.currentTarget.open !== viewState.policy)
                setViewState({ policy: e.currentTarget.open }, { replace: true });
            }}
          >
            <summary>Configure document metadata policy</summary>
            <Form layout="vertical">
              <Form.Item label="Required field types">
                <Select
                  mode="multiple"
                  aria-label="Required metadata policy"
                  value={requiredMetadata}
                  onChange={setRequiredMetadata}
                  options={Object.entries(metadataTypeLabels).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                />
              </Form.Item>
              <Button disabled={working} onClick={() => action('policy', { requiredMetadata })}>
                Save document policy
              </Button>
            </Form>
          </details>
        )}
      {['ordering_reviewed', 'completeness_reviewed', 'metadata_reviewed'].map((key) => (
        <Checkbox
          key={key}
          disabled={!mine}
          checked={draft?.[key]}
          onChange={(e) => {
            setDraft({ ...draft, [key]: e.target.checked });
            setReviewDirty(true);
          }}
        >
          {label(key)}
        </Checkbox>
      ))}
      <label className="qc-field-label" htmlFor="qc-review-notes">
        Review notes
      </label>
      <Input.TextArea
        id="qc-review-notes"
        aria-label="Review notes"
        placeholder="Review notes"
        value={draft?.notes || ''}
        readOnly={!mine}
        onChange={(e) => {
          setDraft({ ...draft, notes: e.target.value });
          setReviewDirty(true);
        }}
        maxLength={4000}
        autoSize={{ minRows: 3, maxRows: 6 }}
      />
      <label className="qc-field-label" htmlFor="qc-ocr-exception">
        OCR exception <span className="muted">Optional</span>
      </label>
      <Input.TextArea
        id="qc-ocr-exception"
        aria-label="OCR exception justification"
        placeholder="OCR exception justification (only if needed)"
        value={draft?.ocr_exception || ''}
        readOnly={!mine}
        maxLength={2000}
        autoSize={{ minRows: 2, maxRows: 5 }}
        onChange={(e) => {
          setDraft({ ...draft, ocr_exception: e.target.value });
          setReviewDirty(true);
        }}
      />
    </div>
  );
  const inspectorItems = [
    {
      key: 'metadata',
      label: 'Metadata',
      children: (
        <MetadataPanel
          key={batchId}
          job={{ id: batchId, status: 'completed' }}
          metadataPath={`/api/batches/${batchId}/metadata`}
          canManage={editable}
          canVerify={mine}
          pageNumbers={Object.fromEntries(data.pages.map((p) => [p.id, p.display_order]))}
          onDirtyChange={setMetadataDirty}
          onSaved={() => load(true).catch((e) => setError(e.message))}
          expandedEvidence={viewState.evidence.split(',')}
          focusedField={viewState.field}
          onEvidenceToggle={(id, open) => {
            const ids = viewState.evidence.split(',').filter((value) => value && value !== id);
            if (open) ids.push(id);
            setViewState({ evidence: ids.join(',') }, { replace: true });
          }}
          onSource={(source) => {
            if (selectPage(source.pageId)) setSourceHighlight(source);
          }}
        />
      ),
    },
    {
      key: 'ocr',
      label: 'OCR Text',
      children: (
        <div className="qc-inspector-scroll qc-ocr-panel">
          <div className="qc-section-heading">
            <h3>Recognized text</h3>
            {ocr && (
              <Tag
                color={
                  ocr.status === 'completed'
                    ? 'success'
                    : ocr.status === 'failed'
                      ? 'error'
                      : 'default'
                }
              >
                {label(ocr.status)}
              </Tag>
            )}
            {mine && (
              <Popconfirm
                title="Reprocess current images using global OCR defaults?"
                description="Unchanged successful inputs are reused. Historical results remain."
                onConfirm={() => action('reprocess-ocr', { requestId: crypto.randomUUID() })}
              >
                <Button disabled={working || dirty}>Reprocess OCR</Button>
              </Popconfirm>
            )}
          </div>
          {ocr ? (
            <>
              <p className="qc-panel-caption">
                {ocr.engine || 'OCR'} ·{' '}
                {ocr.corrected_at ? 'Human correction saved' : 'Machine-recognized text'}
              </p>
              {ocr.error_message && <Alert type="warning" showIcon title={ocr.error_message} />}
              <Input.TextArea
                className="qc-ocr-editor"
                aria-label="QC effective OCR text"
                value={textDraft}
                readOnly={!mine || pageInfo.ocr.status !== 'completed'}
                onChange={(e) => {
                  setTextDraft(e.target.value);
                  setTextDirty(true);
                }}
                rows={12}
              />
              {mine && (
                <Button
                  type="primary"
                  disabled={!textDirty || working}
                  onClick={() =>
                    action('correct-text', { resultId: pageInfo.ocr.result_id, text: textDraft })
                  }
                >
                  Save OCR correction
                </Button>
              )}
              <details
                className="qc-disclosure"
                open={viewState.processing}
                onToggle={(e) => {
                  if (e.currentTarget.open !== viewState.processing)
                    setViewState({ processing: e.currentTarget.open }, { replace: true });
                }}
              >
                <summary>Processing details</summary>
                <Descriptions
                  column={1}
                  size="small"
                  items={[
                    ['Engine', ocr.engine || '—'],
                    ['Engine version', ocr.engine_version || '—'],
                    ['Processed', ocr.processed_at ? dateTime(ocr.processed_at) : 'Not processed'],
                    ['Image revision', ocr.image_revision ?? '—'],
                    ...(processing
                      ? [
                          ['Profile', label(processing.profile)],
                          ['Model / quality', processing.model || label(processing.quality)],
                          ['Resolution', processing.dpi ? `${processing.dpi} DPI` : 'Not recorded'],
                          [
                            'Layout',
                            processing.engine === 'paddleocr'
                              ? 'Automatic'
                              : processing.psm
                                ? `PSM ${processing.psm}`
                                : 'Not recorded',
                          ],
                          ...(processing.cpuThreads
                            ? [['CPU threads', processing.cpuThreads]]
                            : []),
                          [
                            'Image preparation',
                            Object.entries(processing.preprocessing || {})
                              .filter(([, enabled]) => enabled === true)
                              .map(
                                ([key]) =>
                                  ({
                                    deskew: 'Deskew',
                                    denoise: 'Denoise',
                                    contrast: 'Contrast',
                                    grayscale: 'Grayscale',
                                    adaptiveThreshold: 'Adaptive threshold',
                                  })[key] || label(key),
                              )
                              .join(' · ') || 'None',
                          ],
                        ]
                      : []),
                  ].map(([label, children]) => ({ key: label, label, children }))}
                />
              </details>
              <details
                className="qc-disclosure"
                open={viewState.machine}
                onToggle={(e) => {
                  if (e.currentTarget.open !== viewState.machine)
                    setViewState({ machine: e.currentTarget.open }, { replace: true });
                }}
              >
                <summary>Original recognized text</summary>
                <pre className="qc-raw-text">{ocr.extracted_text || 'No text recognized.'}</pre>
              </details>
            </>
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No current OCR for this image revision"
            />
          )}
        </div>
      ),
    },
    {
      key: 'properties',
      label: 'Page Properties',
      children: (
        <div className="qc-inspector-scroll">
          {page && (
            <>
              <div className="qc-section-heading">
                <h3>Page details</h3>
                <Tag>Page {page.display_order}</Tag>
              </div>
              <Descriptions
                bordered
                column={1}
                size="small"
                items={[
                  ['Logical position', page.display_order],
                  ['Immutable capture order', page.capture_order],
                  ['Session', page.session_number],
                  ['Source', page.source],
                  ['Image revision', page.image_revision],
                  ['Rotation', `${page.rotation_degrees}°`],
                  ['Dimensions', `${page.width_px} × ${page.height_px}`],
                  ['DPI', page.dpi],
                  [
                    'Review',
                    page.reviewed_image_revision === page.image_revision
                      ? label(page.review_status)
                      : 'Not reviewed (current image)',
                  ],
                ].map(([label, children]) => ({ key: label, label, children }))}
              />
              <div className="qc-page-actions">
                <Checkbox
                  checked={original}
                  onChange={(e) => {
                    setViewState({ original: e.target.checked, revision: null });
                  }}
                >
                  View immutable original
                </Checkbox>
                {pageMutable && (
                  <Space wrap>
                    <IconButton
                      label="Move page up"
                      icon={<ArrowUpOutlined aria-hidden />}
                      onClick={() => pageAction('reorder', visible[Math.max(0, index - 1)]?.id)}
                      disabled={index <= 0}
                    />
                    <IconButton
                      label="Move page down"
                      icon={<ArrowDownOutlined aria-hidden />}
                      onClick={() => pageAction('reorder', visible[index + 2]?.id || null)}
                      disabled={index < 0 || index >= visible.length - 1}
                    />
                    <IconButton
                      label="Reset rotation"
                      icon={<UndoOutlined aria-hidden />}
                      disabled={working || !page.rotation_degrees}
                      onClick={() => pageAction('reset-rotation')}
                    />
                    <Select
                      aria-label="Move selected page before"
                      placeholder="Move before page…"
                      showSearch
                      optionFilterProp="label"
                      value={null}
                      onChange={(id) => pageAction('reorder', id)}
                      options={visible
                        .filter((p) => p.id !== page.id)
                        .map((p) => ({
                          value: p.id,
                          label: `Page ${p.display_order} · Session ${p.session_number}`,
                        }))}
                    />
                  </Space>
                )}
              </div>
              <div className="qc-section-heading">
                <h3>Image replacements</h3>
              </div>
              {revisionId && (
                <Button onClick={() => setViewState({ revision: null })}>View current image</Button>
              )}
              {!pageInfo?.revisions.length && (
                <p className="qc-panel-caption">
                  No replacements recorded. The captured original is retained.
                </p>
              )}
              {pageInfo?.revisions.map((r) => (
                <div className="qc-revision" key={r.id}>
                  <div>
                    <time>{dateTime(r.created_at)}</time>
                    <span className="muted">
                      SHA-256 <code>{r.sha256.slice(0, 12)}</code>
                    </span>
                  </div>
                  <Button
                    type="link"
                    onClick={() => {
                      setViewState({ original: false, revision: r.id });
                    }}
                  >
                    View revision
                  </Button>
                </div>
              ))}
            </>
          )}
        </div>
      ),
    },
    {
      key: 'issues',
      label: 'Issues',
      children: (
        <div className="qc-inspector-scroll">
          {notes}
          <div className="qc-section-heading">
            <h3>
              Findings <span className="qc-section-count">{data.findings.length}</span>
            </h3>
            {mine && (
              <Button
                onClick={() =>
                  setIssue({
                    category: 'other',
                    severity: 'major',
                    description: '',
                    pageIds: page ? [page.id] : [],
                    status: 'open',
                    resolutionNote: '',
                  })
                }
              >
                Add finding
              </Button>
            )}
          </div>
          {!data.findings.length && (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No findings" />
          )}
          {data.findings.map((f) => (
            <section className="qc-finding" key={f.id}>
              <Space wrap>
                <Tag
                  color={
                    f.severity === 'critical'
                      ? 'error'
                      : f.severity === 'major'
                        ? 'warning'
                        : 'default'
                  }
                >
                  {label(f.severity)}
                </Tag>
                <strong>{label(f.category)}</strong>
                <Tag color={['resolved', 'waived'].includes(f.status) ? 'success' : 'default'}>
                  {label(f.status)}
                </Tag>
              </Space>
              <p>{f.description}</p>
              {f.page_ids.map((id) => (
                <Button key={id} type="link" onClick={() => selectPage(id)}>
                  Page {data.pages.find((p) => p.id === id)?.display_order || '—'}
                </Button>
              ))}
              {f.metadata_field_id && (
                <Button
                  type="link"
                  onClick={() => {
                    setViewState({ tab: 'metadata', field: f.metadata_field_id });
                  }}
                >
                  Metadata field
                </Button>
              )}
              {f.resolution_note && (
                <p className="qc-resolution">
                  <strong>Resolution</strong>
                  {f.resolution_note}
                </p>
              )}
              {mine && (
                <Button
                  onClick={() =>
                    setIssue({
                      ...f,
                      pageIds: f.page_ids,
                      metadataFieldId: f.metadata_field_id,
                      resolutionNote: f.resolution_note || '',
                    })
                  }
                >
                  Update finding
                </Button>
              )}
            </section>
          ))}
        </div>
      ),
    },
    {
      key: 'history',
      label: 'History',
      children: (
        <div className="qc-inspector-scroll">
          <div className="qc-section-heading">
            <h3>Review cycles</h3>
          </div>
          {!data.reviews.length && (
            <p className="qc-panel-caption">Review history begins after capture is completed.</p>
          )}
          <ol className="qc-history-list qc-review-cycles">
            {data.reviews.map((r) => (
              <li key={r.id}>
                <div className="qc-section-heading">
                  <strong>Cycle {r.cycle}</strong>
                  <Tag
                    color={
                      r.outcome === 'passed'
                        ? 'success'
                        : r.outcome === 'returned'
                          ? 'warning'
                          : 'default'
                    }
                  >
                    {r.outcome || 'Draft'}
                  </Tag>
                </div>
                <span>{r.reviewer || 'Unclaimed'}</span>
                {r.decision_reason && <p>{r.decision_reason}</p>}
                <div className="qc-history-meta">
                  {r.decided_at && <time>{dateTime(r.decided_at)}</time>}
                  <span>Revision {r.reviewed_revision || '—'}</span>
                </div>
              </li>
            ))}
          </ol>
          <div className="qc-section-heading">
            <h3>Activity</h3>
          </div>
          <ol className="qc-history-list">
            {data.history.map((h, i) => (
              <li key={i}>
                <strong className="qc-history-action">
                  {activityLabels[h.action] || label(h.action.replaceAll('.', ' · '))}
                </strong>
                <div className="qc-history-meta">
                  <span>{h.actor || 'System'}</span>
                  <time>{dateTime(h.created_at)}</time>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ),
    },
  ];
  return (
    <section
      className="workspace qc-workspace"
      aria-label="Document QC Workspace"
      onKeyDown={keyDown}
      onPointerDownCapture={() => {
        lastInteraction.current = Date.now();
      }}
    >
      <div className="workspace-toolbar batch-context">
        <IconButton
          label="Back"
          icon={<ArrowLeftOutlined aria-hidden />}
          disabled={dirty || working}
          onClick={onBack}
        />
        <h1>{data.batch.batch_code}</h1>
        <Tag>{label(data.document.workflow_status)}</Tag>
        <span className="toolbar-spacer" />
        <IconButton
          label="Reload"
          icon={<ReloadOutlined aria-hidden />}
          disabled={working}
          onClick={() => {
            if (!dirty || window.confirm('Discard unsaved edits and reload?')) {
              load();
              loadPage();
            }
          }}
        />
        {captureMutable && (
          <Button disabled={dirty || working} onClick={() => onCapture(data.batch, page?.id)}>
            Capture / rework
          </Button>
        )}
        {can('qc:review') &&
          ['qc_waiting', 'qc_in_review'].includes(data.document.workflow_status) &&
          !mine && (
            <Button type="primary" disabled={working} onClick={() => action('claim')}>
              Claim document
            </Button>
          )}
        {mine && (
          <>
            <Button disabled={dirty || working} onClick={() => action('release')}>
              Release
            </Button>
            <Button
              disabled={metadataDirty || textDirty || working}
              onClick={() =>
                action('save', {
                  orderingReviewed: !!draft?.ordering_reviewed,
                  completenessReviewed: !!draft?.completeness_reviewed,
                  metadataReviewed: !!draft?.metadata_reviewed,
                  notes: draft?.notes || '',
                  ocrException: draft?.ocr_exception || '',
                })
              }
            >
              Save Draft
            </Button>
            <Button
              danger
              disabled={dirty || working}
              onClick={() => {
                setDecision('return');
                setReason('');
              }}
            >
              Return to Operator
            </Button>
            <Button
              type="primary"
              disabled={dirty || working}
              onClick={() => {
                setDecision('pass');
                setReason('');
              }}
            >
              Pass QC
            </Button>
          </>
        )}
        {can('qc:reassign') && data.document.workflow_status === 'qc_in_review' && !mine && (
          <Button
            onClick={() => {
              setDecision('reassign');
              setReason('');
            }}
          >
            Release for reassignment
          </Button>
        )}
      </div>
      {error && <Alert type="error" showIcon title={error} closable onClose={() => setError('')} />}
      {data.document.workflow_status === 'rework' && (
        <Alert
          type="warning"
          title={`Returned by QC: ${review?.decision_reason || 'Review findings'}`}
          action={<Button onClick={() => setViewState({ tab: 'issues' })}>View findings</Button>}
        />
      )}
      {data.document.workflow_status === 'qc_in_review' && !mine && (
        <Alert
          type="info"
          title={`Read-only review · ${review?.reviewer || 'QC Officer'} · Claim expires ${dateTime(review?.claim_expires_at)}`}
        />
      )}
      <Splitter className="workstation-split qc-split">
        <Splitter.Panel defaultSize="18%" min={170} max="28%">
          <section className="panel page-history">
            <div className="panel-heading">
              <h2>Pages</h2>
              <span>{visible.length}</span>
            </div>
            <div className="panel-tools">
              <Select
                aria-label="QC scan session filter"
                value={session}
                onChange={(id) => {
                  const target = data.pages.find(
                    (p) =>
                      !p.replacement_candidate &&
                      (showExcluded || !p.is_excluded) &&
                      (id === 'all' || p.scan_session_id === id),
                  );
                  selectPage(target?.id || null, { session: id, rail: 1 });
                }}
                options={[
                  { value: 'all', label: 'All sessions · logical order' },
                  ...data.sessions.map((s) => ({
                    value: s.id,
                    label: `Session ${s.session_number} · ${s.status}`,
                  })),
                ]}
              />
              <Checkbox
                checked={showExcluded}
                onChange={(e) => {
                  const excluded = e.target.checked;
                  const target =
                    excluded || !page?.is_excluded ? page : visible.find((p) => !p.is_excluded);
                  selectPage(target?.id || null, { excluded, rail: 1 });
                }}
              >
                Show excluded
              </Checkbox>
            </div>
            <div className="scroll-region scanner-page-list">
              {!visible.length && (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="No pages match this view"
                />
              )}
              {visible.slice((listPage - 1) * 40, listPage * 40).map((p) => (
                <Button
                  type="text"
                  block
                  key={p.id}
                  className={`page-item scanner-page ${p.id === page?.id ? 'selected' : ''}`}
                  aria-label={`Inspect page ${p.display_order}`}
                  aria-pressed={p.id === page?.id}
                  onClick={() => selectPage(p.id)}
                >
                  <Thumbnail
                    src={`/api/pages/${p.id}/thumbnail`}
                    label={`Page ${p.display_order}`}
                    rotation={p.rotation_degrees}
                  />
                  <span className="page-item-info">
                    <strong>Page {p.display_order}</strong>
                    <span>Session {p.session_number}</span>
                    <span>
                      {p.is_excluded
                        ? 'Excluded'
                        : p.reviewed_image_revision === p.image_revision
                          ? label(p.review_status)
                          : 'Not reviewed'}
                    </span>
                    <span className="muted">OCR: {label(p.ocr_status)}</span>
                  </span>
                </Button>
              ))}
            </div>
            <div className="panel-footer">
              <Pagination
                simple
                current={listPage}
                pageSize={40}
                total={visible.length}
                onChange={(rail) => setViewState({ rail })}
              />
            </div>
          </section>
        </Splitter.Panel>
        <Splitter.Panel min={300}>
          <section className="panel preview-panel">
            <div className="panel-heading">
              <Space size={4}>
                <IconButton
                  label="Previous page"
                  icon={<LeftOutlined aria-hidden />}
                  disabled={index <= 0 || working}
                  onClick={() => nextPage(-1)}
                />
                <h2>{page ? `Page ${page.display_order}` : 'Preview'}</h2>
                <IconButton
                  label="Next page"
                  icon={<RightOutlined aria-hidden />}
                  disabled={index >= visible.length - 1 || working}
                  onClick={() => nextPage(1)}
                />
              </Space>
              {page && pageMutable && (
                <Space size={4}>
                  <IconButton
                    label="Rotate left"
                    icon={<RotateLeftOutlined aria-hidden />}
                    disabled={working}
                    onClick={() => pageAction('rotate-left')}
                  />
                  <IconButton
                    label="Rotate right"
                    icon={<RotateRightOutlined aria-hidden />}
                    disabled={working}
                    onClick={() => pageAction('rotate-right')}
                  />
                  <Popconfirm
                    title={
                      page.is_excluded
                        ? 'Restore page?'
                        : 'Exclude page without deleting the original?'
                    }
                    onConfirm={() => pageAction(page.is_excluded ? 'restore' : 'exclude')}
                  >
                    <IconButton
                      label={page.is_excluded ? 'Restore page' : 'Exclude page'}
                      icon={
                        page.is_excluded ? (
                          <UndoOutlined aria-hidden />
                        ) : (
                          <DeleteOutlined aria-hidden />
                        )
                      }
                      danger={!page.is_excluded}
                      disabled={working}
                    />
                  </Popconfirm>
                </Space>
              )}
            </div>
            <PageViewer
              key={`${page?.id}-${page?.image_revision}-${original}-${revisionId}`}
              image={page ? { imageId: page.id } : null}
              viewState={viewState}
              onViewChange={(patch) => setViewState(patch, { replace: !('fullscreen' in patch) })}
              label={
                revisionId
                  ? 'Historical image revision'
                  : original
                    ? 'Immutable original'
                    : 'Current document image'
              }
              rotation={original || revisionId ? 0 : page?.rotation_degrees || 0}
              previewUrl={
                page &&
                (revisionId
                  ? `/api/qc/${batchId}/pages/${page.id}/revisions/${revisionId}/preview`
                  : `/api/pages/${page.id}/${original ? 'original' : 'preview'}`)
              }
              originalUrl={
                page &&
                (revisionId
                  ? `/api/qc/${batchId}/pages/${page.id}/revisions/${revisionId}/image`
                  : `/api/pages/${page.id}/${original ? 'original' : 'image'}`)
              }
              highlight={
                !original &&
                !revisionId &&
                sourceHighlight &&
                sourceHighlight.pageId === page?.id &&
                sourceHighlight.resultId === pageInfo?.ocr?.result_id
                  ? {
                      bounds: sourceHighlight.bounds,
                      pageWidth: pageInfo?.ocr?.structured_result?.pageBounds?.width,
                      pageHeight: pageInfo?.ocr?.structured_result?.pageBounds?.height,
                    }
                  : null
              }
            />
            {mine && page && (
              <div className="panel-footer">
                <Space>
                  <Button
                    disabled={working}
                    onClick={() =>
                      action('page-review', { pageIds: [page.id], status: 'reviewed' })
                    }
                  >
                    Mark reviewed
                  </Button>
                  <Button
                    disabled={working}
                    onClick={() =>
                      action('page-review', { pageIds: [page.id], status: 'needs_correction' })
                    }
                  >
                    Needs correction
                  </Button>
                  <Popconfirm
                    title="Explicitly mark this visible list window reviewed?"
                    description="Only use after inspecting these pages. Other pages are not marked."
                    onConfirm={() =>
                      action('page-review', {
                        pageIds: visible.slice((listPage - 1) * 40, listPage * 40).map((p) => p.id),
                        status: 'reviewed',
                      })
                    }
                  >
                    <Button disabled={working}>Review list window</Button>
                  </Popconfirm>
                </Space>
              </div>
            )}
          </section>
        </Splitter.Panel>
        <Splitter.Panel defaultSize="31%" min={300} max="45%">
          <section className="panel qc-inspector">
            <Tabs
              size="small"
              tabBarGutter={16}
              activeKey={tab}
              onChange={(tab) => setViewState({ tab })}
              items={inspectorItems}
            />
          </section>
        </Splitter.Panel>
      </Splitter>
      <Modal
        title={
          decision === 'pass'
            ? 'Pass QC to Awaiting Approval Level 1?'
            : decision === 'reassign'
              ? 'Release claim for reassignment?'
              : 'Return to Operator'
        }
        open={!!decision}
        onCancel={() => setDecision(null)}
        confirmLoading={working}
        okButtonProps={{ disabled: decision !== 'pass' && !reason.trim() }}
        onOk={async () => {
          if (await action(decision, { reason })) setDecision(null);
        }}
      >
        <p>
          {decision === 'pass'
            ? 'The backend validates integrity, metadata, OCR and the saved checklist, then locks this revision.'
            : 'A reason is required and will remain in history.'}
        </p>
        <Input.TextArea
          aria-label="QC decision reason"
          value={reason}
          maxLength={2000}
          onChange={(e) => setReason(e.target.value)}
        />
      </Modal>
      <Modal
        title={issue?.id ? 'Update finding' : 'Add finding'}
        open={!!issue}
        onCancel={() => setIssue(null)}
        confirmLoading={working}
        onOk={async () => {
          const {
            id,
            pageIds,
            metadataFieldId,
            category,
            severity,
            description,
            status,
            resolutionNote,
          } = issue;
          if (
            await action('findings', {
              id,
              pageIds,
              metadataFieldId,
              category,
              severity,
              description,
              status,
              resolutionNote,
            })
          )
            setIssue(null);
        }}
      >
        {issue && (
          <Form layout="vertical">
            <Form.Item label="Category">
              <Select
                value={issue.category}
                onChange={(category) => setIssue({ ...issue, category })}
                options={categories.map((value) => ({ value, label: label(value) }))}
              />
            </Form.Item>
            <Form.Item label="Severity">
              <Select
                value={issue.severity}
                onChange={(severity) => setIssue({ ...issue, severity })}
                options={['minor', 'major', 'critical'].map((value) => ({ value, label: value }))}
              />
            </Form.Item>
            <Form.Item label="Pages (empty means document-wide)">
              <Select
                mode="multiple"
                showSearch
                optionFilterProp="label"
                value={issue.pageIds}
                onChange={(pageIds) => setIssue({ ...issue, pageIds })}
                options={data.pages.map((p) => ({ value: p.id, label: `Page ${p.display_order}` }))}
              />
            </Form.Item>
            <Form.Item label="Metadata field (optional)">
              <Select
                allowClear
                value={issue.metadataFieldId}
                onChange={(metadataFieldId) => setIssue({ ...issue, metadataFieldId })}
                options={data.metadata.fields.map((f) => ({
                  value: f.id,
                  label: `${label(f.type)} · ${f.value}`,
                }))}
              />
            </Form.Item>
            <Form.Item label="Description">
              <Input.TextArea
                aria-label="Finding description"
                maxLength={2000}
                value={issue.description}
                onChange={(e) => setIssue({ ...issue, description: e.target.value })}
              />
            </Form.Item>
            <Form.Item label="Status">
              <Select
                aria-label="Finding status"
                value={issue.status}
                onChange={(status) => setIssue({ ...issue, status })}
                options={['open', 'in_progress', 'resolved', 'waived'].map((value) => ({
                  value,
                  label: label(value),
                }))}
              />
            </Form.Item>
            <Form.Item label="Resolution / waiver justification">
              <Input.TextArea
                aria-label="Finding resolution note"
                value={issue.resolutionNote}
                maxLength={2000}
                onChange={(e) => setIssue({ ...issue, resolutionNote: e.target.value })}
              />
            </Form.Item>
          </Form>
        )}
      </Modal>
    </section>
  );
}
