import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Descriptions,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Pagination,
  Select,
  Space,
  Spin,
  Splitter,
  Tabs,
  Tag,
} from 'antd';
import {
  ArrowLeftOutlined,
  AuditOutlined,
  CheckCircleOutlined,
  FileTextOutlined,
  QrcodeOutlined,
  ReloadOutlined,
  RollbackOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { api } from './api';
import { dateTime, IconButton, Thumbnail, useNarrow } from './ui';
import { pageName } from './pageLabels';
import PageViewer from './PageViewer';
import { queryChoice, queryPage, queryZoom, useUrlState } from './useUrlState';
import { workflowTag } from './Documents';

function readState(params) {
  return {
    page: params.get('page') || '',
    rail: queryPage(params, 'rail'),
    tab: queryChoice(params, 'tab', ['metadata', 'ocr', 'qc', 'history']),
    zoom: queryZoom(params),
    pixels: params.get('pixels') === '1',
    fullscreen: params.get('fullscreen') === '1',
  };
}
export default function ApprovalDocument({ batchId, user, onBack, onOpenConfirmation, onOpenQc }) {
  const { notification } = App.useApp();
  const [data, setData] = useState(null);
  const [query, setQuery] = useUrlState(readState);
  const [ocr, setOcr] = useState(null);
  const [textLoading, setTextLoading] = useState(false);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [decision, setDecision] = useState(null);
  const [formError, setFormError] = useState('');
  const [form] = Form.useForm();
  const takeDownTarget = Form.useWatch('target', form);
  const narrow = useNarrow();
  const request = useRef(0);
  const decisionVersion = useRef(null);
  const load = useCallback(async () => {
    const id = ++request.current;
    try {
      const next = await api(`/api/records/${batchId}`);
      if (id === request.current) {
        setData(next);
        setError('');
      }
    } catch (error) {
      if (id === request.current) setError(error.message);
    }
  }, [batchId]);
  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, 10000);
    return () => clearInterval(timer);
  }, [load]);
  const pages = data?.pages || [];
  const page = pages.find((page) => page.id === query.page) || pages[0];
  const pageId = page?.id;
  useEffect(() => {
    if (!pageId) return;
    let active = true;
    setTextLoading(true);
    setOcr(null);
    api(`/api/records/${batchId}/pages/${pageId}/text`)
      .then(({ ocr }) => {
        if (active) setOcr(ocr);
      })
      .catch((error) => {
        if (active) setError(error.message);
      })
      .finally(() => {
        if (active) setTextLoading(false);
      });
    return () => {
      active = false;
    };
  }, [batchId, pageId, data?.document.review_cycle, data?.document.revision]);
  function openDecision(action) {
    decisionVersion.current = data.document.version;
    setDecision(action);
    setFormError('');
    form.resetFields();
    const previous = data.review?.decided_by;
    form.setFieldsValue({
      reviewerId: data.qcCandidates.some((item) => item.id === previous) ? previous : undefined,
      authorityId: action === 'assign-l2' ? data.document.assigned_l2_id : undefined,
      ...(action === 'take-down' ? { target: 'qc' } : {}),
    });
  }
  async function save(values) {
    setWorking(true);
    setFormError('');
    try {
      const result = await api(`/api/records/${batchId}/decision`, {
        reason: values.reason,
        ...(decision === 'take-down'
          ? {
              target: values.target,
              ...(values.target === 'qc' ? { reviewerId: values.reviewerId } : {}),
            }
          : decision === 'return'
            ? { reviewerId: values.reviewerId }
            : values.authorityId
              ? { authorityId: values.authorityId }
              : {}),
        action: decision,
        version: decisionVersion.current,
      });
      setDecision(null);
      form.resetFields();
      await load();
      notification.success({
        title:
          result.state === 'approved'
            ? 'Publication confirmed'
            : decision === 'take-down'
              ? 'Publication taken down'
              : decision === 'assign-l2'
                ? 'L2 authority updated'
                : 'Decision recorded',
        description: result.confirmationId
          ? 'A QR confirmation receipt is available. The assigned operator will be notified.'
          : undefined,
        actions: result.confirmationId ? (
          <Button
            icon={<QrcodeOutlined aria-hidden />}
            onClick={() => onOpenConfirmation(result.confirmationId)}
          >
            View / print QR
          </Button>
        ) : undefined,
      });
    } catch (error) {
      setFormError(error.message);
    } finally {
      setWorking(false);
    }
  }
  if (!data)
    return (
      <section className="workspace">
        {error ? (
          <Alert type="error" title={error} action={<Button onClick={load}>Retry</Button>} />
        ) : (
          <Spin />
        )}
      </section>
    );
  const { document: doc, level, settings } = data;
  const rail = Math.min(query.rail, Math.max(1, Math.ceil(pages.length / 40)));
  const final = level === 2 || doc.approval_l2_required === false;
  const authorityRequired = decision === 'assign-l2' || (decision === 'approve' && !final);
  const decisionTitle =
    decision === 'take-down'
      ? 'Take down publication'
      : decision === 'return'
        ? 'Return to QC'
        : decision === 'drop'
          ? 'Drop entire batch'
          : decision === 'assign-l2'
            ? 'Change L2 authority'
            : final
              ? 'Approve & publish'
              : 'Approve & send to L2';
  const history = (
    <div className="qc-inspector-scroll">
      <h3>Approval decisions</h3>
      {!data.history.length && (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No approval decisions yet." />
      )}
      <ol className="qc-history-list">
        {data.history.map((item) => (
          <li key={item.id}>
            <div className="qc-history-heading">
              <strong>
                L{item.level} ·{' '}
                {item.decision === 'approved'
                  ? 'Confirmed'
                  : item.decision === 'returned'
                    ? 'Returned to QC'
                    : 'Batch dropped'}
              </strong>
              <time>{dateTime(item.decided_at)}</time>
            </div>
            <div className="qc-history-meta">
              {item.officer} · QC cycle {item.cycle}
            </div>
            {item.reason && <p className="records-reason">{item.reason}</p>}
            {item.decision === 'approved' && (
              <Button
                type="link"
                icon={<QrcodeOutlined aria-hidden />}
                onClick={() => onOpenConfirmation(item.id)}
              >
                View / print QR
              </Button>
            )}
          </li>
        ))}
      </ol>
      {!!data.withdrawals?.length && (
        <>
          <h3>Publication takedowns</h3>
          <ol className="qc-history-list">
            {data.withdrawals.map((item) => (
              <li key={item.id}>
                <div className="qc-history-heading">
                  <strong>Returned to {item.target === 'qc' ? 'QC' : 'L1'}</strong>
                  <time>{dateTime(item.taken_at)}</time>
                </div>
                <div className="qc-history-meta">
                  {item.officer_name} · Revision {item.revision}
                </div>
                <p className="records-reason">{item.reason}</p>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
  const metadata = (
    <div className="qc-inspector-scroll">
      <h3>{data.snapshot ? 'Locked QC metadata' : 'Current document metadata'}</h3>
      <Descriptions
        size="small"
        column={1}
        items={[
          { key: 'revision', label: 'Revision', children: doc.revision },
          { key: 'cycle', label: 'QC cycle', children: doc.review_cycle },
          {
            key: 'policy',
            label: 'Approval policy',
            children:
              doc.approval_l2_required == null
                ? 'Fixed at first QC Pass'
                : doc.approval_l2_required
                  ? 'L1 → L2'
                  : 'L1 only',
          },
          {
            key: 'published',
            label: 'Published · WIB',
            children: doc.published_at ? dateTime(doc.published_at) : 'Not published',
          },
        ]}
      />
      <dl className="records-metadata">
        {data.metadata.fields.map((field) => (
          <div key={field.id}>
            <dt>
              {field.type.replaceAll('_', ' ')}
              {field.context ? ` · ${field.context}` : ''}
            </dt>
            <dd>{field.value}</dd>
          </div>
        ))}
      </dl>
      {!data.metadata.fields.length && <p className="muted">No metadata has been recorded.</p>}
    </div>
  );
  const qc = (
    <div className="qc-inspector-scroll">
      <h3>QC review</h3>
      <p>
        Reviewed revision {doc.revision} · {dateTime(data.review?.decided_at)}
      </p>
      {data.review?.carried_from_review_id && (
        <p className="qc-panel-caption">
          Original QC Pass carried forward unchanged after publication takedown. This is not a new
          QC inspection.
        </p>
      )}
      {data.review?.decision_reason && (
        <p className="records-reason">{data.review.decision_reason}</p>
      )}
      {data.review?.ocr_exception && (
        <Alert
          type="warning"
          showIcon
          title="QC accepted an OCR exception"
          description={data.review.ocr_exception}
        />
      )}
      <h3>Findings</h3>
      {data.findings.length ? (
        data.findings.map((finding) => (
          <div className="records-finding" key={finding.id}>
            <Space wrap>
              <Tag>{finding.severity}</Tag>
              <Tag>{finding.status}</Tag>
            </Space>
            <p className="records-reason">{finding.description}</p>
            {finding.resolution_note && (
              <p className="muted records-reason">{finding.resolution_note}</p>
            )}
          </div>
        ))
      ) : (
        <p className="muted">No findings in this revision.</p>
      )}
    </div>
  );
  return (
    <section className="workspace" aria-label="Document approval and history">
      <div className="workspace-toolbar">
        <IconButton
          label="Back to documents"
          icon={<ArrowLeftOutlined aria-hidden />}
          disabled={working}
          onClick={onBack}
        />
        <h1>{data.batch.batch_code}</h1>
        {workflowTag(doc.workflow_status)}
        <Tag>Revision {doc.revision}</Tag>
        <span className="toolbar-spacer" />
        {(user.permissions.includes('qc:read') || data.batch.assigned_operator_id === user.id) && (
          <Button disabled={working} onClick={() => onOpenQc(batchId)}>
            Open document workspace
          </Button>
        )}
        <IconButton
          label="Refresh"
          icon={<ReloadOutlined aria-hidden />}
          disabled={working}
          onClick={load}
        />
        {data.canAssign && (
          <Button disabled={working || !!error} onClick={() => openDecision('assign-l2')}>
            Change L2 authority
          </Button>
        )}
        {data.canTakeDown && (
          <Button
            danger
            icon={<RollbackOutlined aria-hidden />}
            disabled={working || !!error}
            onClick={() => openDecision('take-down')}
          >
            Take down publication
          </Button>
        )}
        {data.canDecide && (
          <Space size={4} wrap>
            <Button
              icon={<RollbackOutlined aria-hidden />}
              disabled={working || !!error}
              onClick={() => openDecision('return')}
            >
              Return to QC
            </Button>
            <Button
              danger
              icon={<StopOutlined aria-hidden />}
              disabled={working || !!error}
              onClick={() => openDecision('drop')}
            >
              Drop batch
            </Button>
            <Button
              type="primary"
              icon={<CheckCircleOutlined aria-hidden />}
              disabled={working || !!error}
              onClick={() => openDecision('approve')}
            >
              {final ? 'Approve & publish' : 'Approve & send to L2'}
            </Button>
          </Space>
        )}
      </div>
      {error && <Alert type="error" showIcon title={error} />}
      {data.blocked && <Alert type="info" showIcon title={data.blocked} />}
      {data.canDecide && (
        <p className="qc-panel-caption">
          L{level} · {settings[`l${level}_label`]} · Read-only review of QC revision {doc.revision}.{' '}
          {final
            ? 'Your explicit confirmation publishes this revision.'
            : 'Select the L2 authority who will confirm publication.'}
        </p>
      )}
      {narrow && (
        <Select
          aria-label="Document page"
          value={pageId}
          showSearch
          optionFilterProp="label"
          options={pages.map((item) => ({ value: item.id, label: pageName(item) }))}
          onChange={(page) => setQuery({ page }, { replace: true })}
        />
      )}
      <Splitter
        key={narrow ? 'narrow' : 'desktop'}
        orientation={narrow ? 'vertical' : 'horizontal'}
        className="workstation-split qc-split records-split"
      >
        {!narrow && (
          <Splitter.Panel defaultSize="18%" min={170} max="28%">
            <section className="panel records-page-rail">
              <div className="panel-heading">
                <strong>Pages</strong>
                <span className="muted">{pages.length}</span>
              </div>
              <div className="records-page-list">
                <List
                  dataSource={pages.slice((rail - 1) * 40, rail * 40)}
                  locale={{ emptyText: 'No included pages' }}
                  renderItem={(item) => (
                    <List.Item>
                      <button
                        type="button"
                        className={`records-page-button${pageId === item.id ? ' is-selected' : ''}`}
                        aria-current={pageId === item.id ? 'page' : undefined}
                        onClick={() => setQuery({ page: item.id }, { replace: true })}
                      >
                        <Thumbnail
                          src={`/api/records/${batchId}/pages/${item.id}/thumbnail?revision=${doc.review_cycle}-${item.image_revision}-${item.active_image_sha256}`}
                          rotation={item.rotation_degrees}
                          label={pageName(item)}
                        />
                        <span>{pageName(item)}</span>
                      </button>
                    </List.Item>
                  )}
                />
              </div>
              <Pagination
                simple
                size="small"
                current={rail}
                pageSize={40}
                total={pages.length}
                onChange={(rail) => setQuery({ rail }, { replace: true })}
              />
            </section>
          </Splitter.Panel>
        )}
        <Splitter.Panel min={narrow ? 160 : 280}>
          <PageViewer
            key={`${pageId}:${doc.review_cycle}:${doc.revision}:${page?.active_image_sha256}`}
            image={
              page
                ? {
                    imageId: `${page.id}:${doc.review_cycle}:${doc.revision}`,
                    ...(page.active_image_sha256 === page.sha256
                      ? { width: page.width_px, height: page.height_px }
                      : {}),
                  }
                : null
            }
            rotation={page?.rotation_degrees || 0}
            label={page ? pageName(page) : 'Document preview'}
            previewUrl={page ? `/api/records/${batchId}/pages/${page.id}/preview` : ''}
            originalUrl={page ? `/api/records/${batchId}/pages/${page.id}/image` : ''}
            allowDownload={false}
            viewState={{ zoom: query.zoom, pixels: query.pixels, fullscreen: query.fullscreen }}
            onViewChange={(patch) => setQuery(patch, { replace: true })}
          />
        </Splitter.Panel>
        <Splitter.Panel
          defaultSize={narrow ? '45%' : '32%'}
          min={narrow ? 160 : 280}
          max={narrow ? '65%' : '46%'}
        >
          <section className="panel qc-inspector">
            <Tabs
              activeKey={query.tab}
              onChange={(tab) => setQuery({ tab }, { replace: true })}
              items={[
                {
                  key: 'metadata',
                  label: (
                    <Space>
                      <FileTextOutlined aria-hidden />
                      Metadata
                    </Space>
                  ),
                  children: metadata,
                },
                {
                  key: 'ocr',
                  label: 'OCR text',
                  children: (
                    <div className="qc-inspector-scroll">
                      {textLoading ? (
                        <Spin />
                      ) : (
                        <>
                          <h3>{data.snapshot ? 'Reviewed OCR text' : 'Current OCR text'}</h3>
                          <pre className="records-ocr-text">
                            {ocr?.corrected_text ??
                              ocr?.extracted_text ??
                              'No recognized text is available for this page.'}
                          </pre>
                        </>
                      )}
                    </div>
                  ),
                },
                { key: 'qc', label: 'QC', children: qc },
                {
                  key: 'history',
                  label: (
                    <Space>
                      <AuditOutlined aria-hidden />
                      History
                    </Space>
                  ),
                  children: history,
                },
              ]}
            />
          </section>
        </Splitter.Panel>
      </Splitter>
      <Modal
        title={decisionTitle}
        open={!!decision}
        width={560}
        onCancel={() => {
          if (!working) {
            setDecision(null);
            form.resetFields();
          }
        }}
        onOk={() => form.submit()}
        okText={decisionTitle}
        okButtonProps={{ danger: decision === 'drop' || decision === 'take-down' }}
        cancelButtonProps={{ disabled: working }}
        confirmLoading={working}
        maskClosable={false}
        destroyOnHidden
      >
        <p className="admin-modal-intro">
          {decision === 'take-down'
            ? 'Remove this publication from the viewer library and block new page/PDF access. Returning to QC requires a new QC Pass; returning to L1 keeps the exact signed QC snapshot. Fresh approval decisions are required under the fixed policy. Prior receipts/history and already downloaded copies remain.'
            : decision === 'drop'
              ? 'Close the entire batch without publication. Originals, ownership, QR receipts and decision history remain; this is not physical deletion.'
              : decision === 'return'
                ? 'Return to the previous QC officer by default. Corrections require a new QC Pass and fresh L1/L2 decisions.'
                : decision === 'assign-l2'
                  ? 'Choose a replacement authority. The new officer must explicitly confirm publication.'
                  : final
                    ? 'Publish the exact QC-reviewed revision to the authenticated Documents registry and approved Viewer library. No public link is created.'
                    : 'Approve this QC-reviewed revision and nominate the L2 officer who must confirm publication.'}
        </p>
        {formError && <Alert type="error" showIcon title={formError} />}
        <Form form={form} layout="vertical" onFinish={save} disabled={working}>
          {decision === 'take-down' && (
            <Form.Item name="target" label="Send back to" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'qc', label: 'QC — new inspection and approvals' },
                  { value: 'l1', label: 'L1 — keep QC snapshot, repeat approvals' },
                ]}
              />
            </Form.Item>
          )}
          {authorityRequired && (
            <Form.Item
              name="authorityId"
              label="L2 confirmation authority"
              rules={[{ required: true, message: 'Choose the L2 authority.' }]}
            >
              <Select
                showSearch
                optionFilterProp="label"
                placeholder="Select an eligible L2 officer"
                options={data.l2Candidates.map((item) => ({
                  value: item.id,
                  label: `${item.display_name} (${item.username})`,
                }))}
              />
            </Form.Item>
          )}
          {(decision === 'return' || (decision === 'take-down' && takeDownTarget !== 'l1')) && (
            <Form.Item
              name="reviewerId"
              label="Return to QC officer"
              rules={[{ required: true, message: 'Choose an available QC officer.' }]}
              extra="If the previous officer is no longer eligible, select another independent QC officer."
            >
              <Select
                showSearch
                optionFilterProp="label"
                options={data.qcCandidates.map((item) => ({
                  value: item.id,
                  label: `${item.display_name} (${item.username})`,
                }))}
              />
            </Form.Item>
          )}
          <Form.Item
            name="reason"
            label={decision === 'approve' ? 'Decision note (optional)' : 'Reason'}
            rules={[
              { required: decision !== 'approve', whitespace: decision !== 'approve', max: 2000 },
            ]}
          >
            <Input.TextArea rows={4} maxLength={2000} showCount />
          </Form.Item>
        </Form>
      </Modal>
    </section>
  );
}
