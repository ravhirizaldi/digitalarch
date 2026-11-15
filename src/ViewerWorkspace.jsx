import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Descriptions,
  Empty,
  Input,
  Modal,
  Pagination,
  Radio,
  Select,
  Spin,
  Tabs,
  Table,
} from 'antd';
import {
  AppstoreOutlined,
  DownloadOutlined,
  FileTextOutlined,
  ReloadOutlined,
  SearchOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import { api } from './api';
import { dateTime, IconButton, Thumbnail } from './ui';
import PageViewer from './PageViewer';
import WorklistTable from './WorklistTable';
import { queryChoice, queryPage, useUrlState } from './useUrlState';
import { parsePageSelection } from './viewerPages';
import './viewer.css';
import useViewerDownload from './useViewerDownload';
import { metadataTypeLabels } from './MetadataPanel';

const validId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function read(params) {
  const open = [...new Set((params.get('open') || '').split(',').filter((id) => validId.test(id)))];
  const tab = params.get('tab');
  return {
    open: open.join(','),
    tab: open.includes(tab) ? tab : 'library',
    layout: queryChoice(params, 'layout', ['list', 'grid']),
    q: (params.get('q') || '').slice(0, 240),
    type: (params.get('type') || '').slice(0, 240),
    sort: queryChoice(params, 'sort', ['published_at', 'title', 'document_date']),
    direction: queryChoice(params, 'direction', ['desc', 'asc']),
    page: queryPage(params),
    size: Number(queryChoice(params, 'size', ['25', '50', '100'])),
  };
}
const documentDate = (value) => (value ? String(value).slice(0, 10) : 'Not set');
function Metadata({ doc, fields = [] }) {
  return (
    <>
      <Descriptions
        size="small"
        column={{ xs: 1, sm: 2, lg: 3 }}
        items={[
          { key: 'number', label: 'Number', children: doc.archive_number || 'Not set' },
          { key: 'type', label: 'Type', children: doc.document_type || 'Not set' },
          { key: 'date', label: 'Document date', children: documentDate(doc.document_date) },
          { key: 'pages', label: 'Pages', children: doc.page_count },
          { key: 'published', label: 'Published', children: dateTime(doc.published_at) },
        ]}
      />
      <h3>Document metadata</h3>
      <Table
        size="small"
        pagination={false}
        rowKey="id"
        tableLayout="fixed"
        dataSource={fields.map((field, index) => ({ ...field, id: index }))}
        columns={[
          {
            title: 'Field',
            dataIndex: 'type',
            width: 200,
            render: (type) => metadataTypeLabels[type] || type,
          },
          {
            title: 'Context',
            dataIndex: 'context',
            width: 280,
            render: (context) => context || '—',
          },
          {
            title: 'Value',
            dataIndex: 'value',
            render: (value) => <span className="viewer-metadata-value">{value}</span>,
          },
        ]}
        scroll={{ x: 800, y: 'min(52dvh, 560px)' }}
        locale={{ emptyText: 'No additional document metadata.' }}
      />
    </>
  );
}

export default function ViewerWorkspace() {
  const download = useViewerDownload();
  const [query, setQuery] = useUrlState(read);
  const [titles, setTitles] = useState({}),
    [error, setError] = useState(''),
    [working, setWorking] = useState(false);
  const ids = query.open ? query.open.split(',') : [];
  const loaded = useCallback(
    (id, title) =>
      setTitles((current) => (current[id] === title ? current : { ...current, [id]: title })),
    [],
  );
  async function activity(action, batchId, value) {
    await api('/api/viewer/activity', {
      action,
      ...(batchId ? { batchId } : {}),
      ...(value ? { value } : {}),
    });
  }
  async function changeTab(id) {
    setWorking(true);
    try {
      await activity('tab_selected', id === 'library' ? null : id);
      setQuery({ tab: id });
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  async function openDocument(doc) {
    setWorking(true);
    try {
      await activity(ids.includes(doc.id) ? 'tab_selected' : 'tab_opened', doc.id);
      loaded(doc.id, doc.title || 'Untitled document');
      setQuery({ open: [...new Set([...ids, doc.id])].join(','), tab: doc.id });
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  async function closeTab(id) {
    setWorking(true);
    try {
      await activity('tab_closed', id);
      const index = ids.indexOf(id),
        next = ids.filter((key) => key !== id);
      setQuery({
        open: next.join(','),
        tab: query.tab === id ? next[Math.min(index, next.length - 1)] || 'library' : query.tab,
      });
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <section className="workspace viewer-workspace" aria-label="Published document library">
      {error && <Alert type="error" showIcon title={error} closable onClose={() => setError('')} />}
      <Tabs
        className="viewer-tabs"
        type="editable-card"
        hideAdd
        activeKey={query.tab}
        destroyOnHidden={false}
        tabBarExtraContent={
          download.hasDownload ? (
            <Button icon={<DownloadOutlined aria-hidden />} onClick={download.show}>
              Download progress
            </Button>
          ) : null
        }
        onChange={(id) => {
          if (!working) changeTab(id);
        }}
        onEdit={(id, action) => {
          if (action === 'remove' && !working) closeTab(id);
        }}
        items={[
          {
            key: 'library',
            label: 'Library',
            closable: false,
            children: (
              <Library
                query={query}
                setQuery={setQuery}
                active={query.tab === 'library'}
                onOpen={openDocument}
                activity={activity}
                disabled={working}
              />
            ),
          },
          ...ids.map((id) => ({
            key: id,
            label: (
              <span className="viewer-tab-title" title={titles[id] || 'Document'}>
                {titles[id] || `Document ${id.slice(0, 8)}`}
              </span>
            ),
            children: (
              <ViewerDocument
                batchId={id}
                active={query.tab === id}
                onLoaded={loaded}
                onDownload={download.start}
                downloading={download.busy}
              />
            ),
          })),
        ]}
      />
    </section>
  );
}

function Library({ query, setQuery, active, onOpen, activity, disabled }) {
  const [data, setData] = useState({ records: [], total: 0, types: [] }),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const [search, setSearch] = useState(query.q);
  const request = useRef(0);
  const params = new URLSearchParams({
    search: query.q,
    type: query.type,
    sort: query.sort,
    direction: query.direction,
    limit: String(query.size),
    offset: String((query.page - 1) * query.size),
  }).toString();
  const load = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    try {
      const next = await api(`/api/viewer/documents?${params}`);
      if (id === request.current) {
        setData(next);
        setError('');
      }
    } catch (e) {
      if (id === request.current) setError(e.message);
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [params]);
  useEffect(() => {
    const requests = request;
    if (active) load();
    return () => {
      requests.current++;
    };
  }, [active, load]);
  useEffect(() => {
    setSearch(query.q);
  }, [query.q]);
  async function layout(value) {
    try {
      await activity('layout_changed', null, value);
      setQuery({ layout: value });
    } catch (e) {
      setError(e.message);
    }
  }
  const pagination = {
    current: query.page,
    pageSize: query.size,
    total: data.total,
    onChange: (page, size) => setQuery({ page: size === query.size ? page : 1, size }),
  };
  return (
    <div className="workspace viewer-library">
      <div className="workspace-toolbar">
        <h1>Published documents</h1>
        <Input.Search
          className="document-search"
          aria-label="Search published documents"
          placeholder="Title, document number or type"
          prefix={<SearchOutlined aria-hidden />}
          value={search}
          maxLength={240}
          allowClear
          onChange={(e) => setSearch(e.target.value)}
          onSearch={() => setQuery({ q: search, page: 1 })}
        />
        <Select
          aria-label="Filter document type"
          value={query.type}
          onChange={(type) => setQuery({ type, page: 1 })}
          options={[
            { value: '', label: 'All document types' },
            ...data.types.map((type) => ({ value: type, label: type })),
          ]}
        />
        <Select
          aria-label="Sort published documents"
          value={query.sort}
          onChange={(sort) => setQuery({ sort, page: 1 })}
          options={[
            { value: 'published_at', label: 'Publication date' },
            { value: 'title', label: 'Title' },
            { value: 'document_date', label: 'Document date' },
          ]}
        />
        <Select
          aria-label="Sort direction"
          value={query.direction}
          onChange={(direction) => setQuery({ direction, page: 1 })}
          options={[
            { value: 'desc', label: 'Descending' },
            { value: 'asc', label: 'Ascending' },
          ]}
        />
        <span className="toolbar-spacer" />
        <Radio.Group
          value={query.layout}
          onChange={(e) => layout(e.target.value)}
          aria-label="Library layout"
        >
          <Radio.Button value="list" aria-label="List view">
            <UnorderedListOutlined aria-hidden />
          </Radio.Button>
          <Radio.Button value="grid" aria-label="Grid view">
            <AppstoreOutlined aria-hidden />
          </Radio.Button>
        </Radio.Group>
        <IconButton
          label="Refresh library"
          icon={<ReloadOutlined aria-hidden />}
          disabled={loading}
          onClick={load}
        />
      </div>
      {error && <Alert type="error" showIcon title={error} />}
      {query.layout === 'list' ? (
        <WorklistTable
          loading={loading}
          dataSource={data.records}
          columns={[
            {
              title: 'Document',
              dataIndex: 'title',
              width: 320,
              render: (title, row) => (
                <Button
                  type="link"
                  className="worklist-document-link"
                  title={title || 'Untitled document'}
                  disabled={disabled}
                  onClick={() => onOpen(row)}
                >
                  {title || 'Untitled document'}
                </Button>
              ),
            },
            { title: 'Number', dataIndex: 'archive_number', render: (v) => v || 'Not set' },
            { title: 'Type', dataIndex: 'document_type', render: (v) => v || 'Not set' },
            { title: 'Document date', dataIndex: 'document_date', render: documentDate },
            { title: 'Pages', dataIndex: 'page_count', align: 'right' },
            { title: 'Published', dataIndex: 'published_at', render: dateTime },
          ]}
          scroll={{ x: 1100 }}
          totals={[
            {
              label: 'published documents',
              value: data.total,
              icon: <FileTextOutlined aria-hidden />,
            },
          ]}
          pagination={pagination}
          locale={{ emptyText: <Empty description="No published documents match your filters." /> }}
        />
      ) : (
        <>
          <div className="viewer-grid" aria-busy={loading}>
            {loading ? (
              <Spin />
            ) : data.records.length ? (
              data.records.map((doc) => (
                <Button
                  className="viewer-record"
                  key={doc.id}
                  disabled={disabled}
                  onClick={() => onOpen(doc)}
                >
                  <span className="viewer-cover">
                    {doc.cover_page_id ? (
                      <Thumbnail
                        src={`/api/viewer/documents/${doc.id}/pages/${doc.cover_page_id}/thumbnail`}
                        rotation={doc.cover_rotation}
                        label={`Cover of ${doc.title || 'Untitled document'}`}
                      />
                    ) : (
                      <span>No cover available</span>
                    )}
                  </span>
                  <span className="viewer-card-title">{doc.title || 'Untitled document'}</span>
                  <span className="viewer-card-date">{documentDate(doc.document_date)}</span>
                </Button>
              ))
            ) : (
              <Empty description="No published documents match your filters." />
            )}
          </div>
          <div className="worklist-footer">
            <span>{data.total} published documents</span>
            <Pagination
              size="small"
              showSizeChanger
              pageSizeOptions={[25, 50, 100]}
              {...pagination}
            />
          </div>
        </>
      )}
    </div>
  );
}

function ViewerDocument({ batchId, active, onLoaded, onDownload, downloading }) {
  const [data, setData] = useState(null),
    [pageNumber, setPageNumber] = useState(1),
    [view, setView] = useState({ zoom: 'width', pixels: false, fullscreen: false });
  const [error, setError] = useState(''),
    [working, setWorking] = useState(false),
    [downloadOpen, setDownloadOpen] = useState(false),
    [metadataOpen, setMetadataOpen] = useState(false),
    [selection, setSelection] = useState('current'),
    [range, setRange] = useState('');
  const load = useCallback(async () => {
    try {
      const next = await api(`/api/viewer/documents/${batchId}`);
      setData(next);
      setPageNumber((number) => Math.min(number, Math.max(1, next.pages.length)));
      onLoaded(batchId, next.document.title || 'Untitled document');
      setError('');
    } catch (e) {
      setData(null);
      setError(e.message);
    }
  }, [batchId, onLoaded]);
  useEffect(() => {
    if (!active) return;
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, 30000);
    return () => clearInterval(timer);
  }, [active, load]);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      api('/api/viewer/activity', {
        action: 'view_changed',
        batchId,
        value: JSON.stringify(view),
      }).catch((error) => setError(`Activity reporting failed: ${error.message}`));
    }, 250);
    return () => clearTimeout(timer);
  }, [active, batchId, view]);
  async function event(action, value) {
    await api('/api/viewer/activity', { action, batchId, value });
  }
  async function choosePage(number) {
    try {
      await event('page_selected', String(number));
      setPageNumber(number);
      setView((old) => ({ ...old, pixels: false }));
    } catch (e) {
      setError(e.message);
    }
  }
  function changeView(patch) {
    setView((old) => ({ ...old, ...patch }));
  }
  let numbers = [],
    selectionError = '';
  if (data) {
    try {
      numbers =
        selection === 'all'
          ? data.pages.map((p) => p.number)
          : selection === 'current'
            ? [pageNumber]
            : parsePageSelection(range, data.pages.length);
    } catch (e) {
      selectionError = e.message;
    }
  }
  async function prepare() {
    setWorking(true);
    setError('');
    try {
      await onDownload(
        batchId,
        {
          revision: data.document.revision,
          selection,
          ...(selection === 'selected'
            ? { range }
            : selection === 'current'
              ? { currentPage: pageNumber }
              : {}),
        },
        data.document.title || 'Untitled document',
      );
      setDownloadOpen(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  if (!active) return null;
  if (!data)
    return (
      <div className="workspace">
        {error ? (
          <Alert
            type="error"
            showIcon
            title={error}
            action={<Button onClick={load}>Retry</Button>}
          />
        ) : (
          <Spin description="Opening published document" />
        )}
      </div>
    );
  const page = data.pages[pageNumber - 1] || data.pages[0];
  const base = page ? `/api/viewer/documents/${batchId}/pages/${page.id}` : '';
  const windowStart = Math.floor((pageNumber - 1) / 40) * 40;
  return (
    <section
      className="workspace viewer-document"
      aria-label={data.document.title || 'Published document'}
    >
      <div className="workspace-toolbar">
        <h1 className="viewer-document-title" title={data.document.title}>
          {data.document.title || 'Untitled document'}
        </h1>
        <span className="toolbar-spacer" />
        <Button
          className="viewer-metadata-toggle"
          icon={<FileTextOutlined aria-hidden />}
          onClick={() => setMetadataOpen(true)}
        >
          Metadata
        </Button>
        <Button
          icon={<DownloadOutlined aria-hidden />}
          disabled={working || !page || downloading}
          onClick={async () => {
            try {
              await event('download_selection', 'opened');
              setDownloadOpen(true);
            } catch (e) {
              setError(e.message);
            }
          }}
        >
          Download PDF
        </Button>
      </div>
      {error && <Alert type="error" showIcon title={error} closable onClose={() => setError('')} />}
      <div className="viewer-document-panes">
        <aside className="panel viewer-page-rail">
          <div className="panel-heading">
            <h2>Pages</h2>
            <span>{data.pages.length}</span>
          </div>
          <div className="scroll-region">
            {data.pages.slice(windowStart, windowStart + 40).map((p) => (
              <Button
                key={p.id}
                type="text"
                block
                className={`page-item scanner-page${p.number === pageNumber ? ' selected' : ''}`}
                aria-pressed={p.number === pageNumber}
                aria-label={`View page ${p.number}`}
                onClick={() => choosePage(p.number)}
              >
                <Thumbnail
                  src={`/api/viewer/documents/${batchId}/pages/${p.id}/thumbnail`}
                  rotation={p.rotation}
                  label={`Page ${p.number}`}
                />
                <span>Page {p.number}</span>
              </Button>
            ))}
          </div>
        </aside>
        <section className="panel viewer-page-preview">
          <div className="panel-heading">
            <h2>Published page image</h2>
            <Pagination
              simple
              current={pageNumber}
              pageSize={1}
              total={data.pages.length}
              onChange={choosePage}
            />
          </div>
          <PageViewer
            key={`${page?.id}-${data.document.revision}`}
            image={page ? { imageId: page.id } : null}
            label={`Page ${page?.number || 1}`}
            rotation={page?.rotation || 0}
            previewUrl={`${base}/preview`}
            originalUrl={`${base}/image`}
            allowDownload={false}
            viewState={view}
            onViewChange={changeView}
          />
        </section>
      </div>
      <Modal
        className="viewer-metadata-modal"
        title="Document metadata"
        open={metadataOpen}
        onCancel={() => setMetadataOpen(false)}
        width={1200}
        centered
        footer={<Button onClick={() => setMetadataOpen(false)}>Close</Button>}
      >
        <Metadata doc={data.document} fields={data.metadata} />
      </Modal>
      <Modal
        title="Download image-only PDF"
        open={downloadOpen}
        onCancel={async () => {
          if (working) return;
          try {
            await event('download_selection', 'cancelled');
            setDownloadOpen(false);
          } catch (e) {
            setError(e.message);
          }
        }}
        okText={`Download PDF (${numbers.length} pages)`}
        onOk={prepare}
        confirmLoading={working}
        okButtonProps={{ disabled: !!selectionError || !numbers.length }}
      >
        <p>All means every page in this document, not the whole library. Downloads are recorded.</p>
        <Radio.Group
          className="viewer-download-options"
          value={selection}
          onChange={async (e) => {
            try {
              await event('download_selection', e.target.value);
              setSelection(e.target.value);
            } catch (err) {
              setError(err.message);
            }
          }}
          options={[
            { value: 'current', label: `Current page (${pageNumber})` },
            { value: 'selected', label: 'Selected pages' },
            { value: 'all', label: `All ${data.pages.length} pages` },
          ]}
        />
        {selection === 'selected' && (
          <label className="viewer-range">
            Page numbers or ranges
            <Input
              aria-label="PDF page selection"
              value={range}
              maxLength={2000}
              placeholder="1, 3, 8–12"
              onChange={(e) => setRange(e.target.value)}
            />
            <span className="muted">{selectionError || `${numbers.length} pages selected`}</span>
          </label>
        )}
        <p className="muted">
          Only page images are included. No OCR text or internal workflow information is added.
        </p>
      </Modal>
    </section>
  );
}
