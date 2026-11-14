import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Empty, Input, Popconfirm, Select, Space, Spin, Tag } from 'antd';
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { api } from './api';
import { dateTime, IconButton } from './ui';

export const metadataTypeLabels = {
  title: 'Title',
  subtitle: 'Subtitle',
  document_number: 'Document number',
  serial_number: 'Serial number',
  person: 'Person',
  company: 'Company / organization',
  address: 'Address',
  date: 'Date',
  phone: 'Phone / fax',
  email: 'Email',
  identity_number: 'Identity number',
  tax_number: 'Tax number',
  position: 'Position / role',
  model: 'Model',
  service_id: 'Service / customer ID',
  amount: 'Amount',
  reference: 'Reference',
  other: 'Other',
  document_type: 'Document type',
  physical_location: 'Physical location',
};
const types = metadataTypeLabels;

export default function MetadataPanel({
  job,
  canManage,
  onSource,
  onDirtyChange,
  metadataPath,
  canVerify = false,
  onSaved,
  pageNumbers = {},
  expandedEvidence,
  onEvidenceToggle,
  focusedField,
}) {
  const base = metadataPath || `/api/ocr/jobs/${job.id}/metadata`;
  const [data, setData] = useState(null);
  const [fields, setFields] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const accept = useCallback((metadata) => {
    setData(metadata);
    setFields(metadata.fields);
    setDirty(false);
    setError('');
  }, []);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      accept((await api(base)).metadata);
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }, [base, accept]);
  useEffect(() => {
    let alive = true;
    api(base)
      .then(({ metadata }) => {
        if (alive) accept(metadata);
      })
      .catch((error) => {
        if (alive) setError(error.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [base, accept]);
  useEffect(() => {
    onDirtyChange(dirty);
    const warn = (event) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
      onDirtyChange(false);
    };
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!loading && focusedField)
      document.getElementById(`metadata-${focusedField}`)?.scrollIntoView({ block: 'nearest' });
  }, [focusedField, loading]);
  function edit(index, patch) {
    setFields((current) =>
      current.map((field, i) =>
        i === index
          ? {
              ...field,
              ...(metadataPath && !patch.verification ? { verification: 'needs_review' } : {}),
              ...('value' in patch && !patch.candidateId ? { candidateId: undefined } : {}),
              ...patch,
            }
          : field,
      ),
    );
    setDirty(true);
  }
  async function action(extract = false) {
    setWorking(extract ? 'extract' : 'save');
    setError('');
    try {
      const body = extract
        ? { version: data.version }
        : {
            version: data.version,
            fields: fields.map(({ id, type, value, context, verification, candidateId }) => ({
              id,
              type,
              value,
              context,
              ...(metadataPath
                ? { verification: verification || 'needs_review', candidateId }
                : {}),
            })),
          };
      accept(
        (await api(`${base}${extract ? '/extract' : ''}`, body, extract ? 'POST' : 'PATCH'))
          .metadata,
      );
      onSaved?.();
    } catch (error) {
      setError(error.message);
    } finally {
      setWorking('');
    }
  }
  const finished = !['queued', 'running', 'paused'].includes(job.status);
  const reloadButton = (
    <IconButton
      label="Reload metadata"
      icon={<ReloadOutlined />}
      disabled={loading || !!working}
      onClick={dirty ? undefined : load}
    />
  );
  const extractButton = (
    <Button
      disabled={!data || loading || !!working || !finished || (!!metadataPath && dirty)}
      loading={working === 'extract'}
      onClick={data?.version || dirty ? undefined : () => action(true)}
    >
      Extract all pages
    </Button>
  );
  return (
    <div className="metadata-panel">
      <div className="metadata-toolbar">
        <strong>{metadataPath ? 'Document metadata' : 'Run metadata history'}</strong>
        <Space size={4} wrap>
          {dirty ? (
            <Popconfirm title="Discard unsaved metadata edits and reload?" onConfirm={load}>
              {reloadButton}
            </Popconfirm>
          ) : (
            reloadButton
          )}
          {canManage && (
            <>
              {data?.version || dirty ? (
                <Popconfirm
                  title={
                    metadataPath
                      ? 'Refresh machine candidates?'
                      : 'Replace metadata with fresh suggestions?'
                  }
                  description={
                    metadataPath
                      ? 'Human values and verification are preserved. Save unsaved edits first.'
                      : 'Saved corrections and unsaved edits will be replaced. OCR text and original images are unchanged.'
                  }
                  onConfirm={() => action(true)}
                >
                  {extractButton}
                </Popconfirm>
              ) : (
                extractButton
              )}
              <Button
                type="primary"
                loading={working === 'save'}
                disabled={
                  !dirty || !!working || loading || fields.some((field) => !field.value.trim())
                }
                onClick={() => action()}
              >
                Save metadata
              </Button>
            </>
          )}
        </Space>
      </div>
      {error && <Alert type="error" showIcon title={error} />}
      <div className="metadata-scroll">
        {loading ? (
          <Spin />
        ) : (
          <>
            <p className="metadata-intro">
              Review suggested values against the source pages before verifying.
            </p>
            {!finished && (
              <Alert
                type="info"
                title="Extraction is available when this OCR run finishes or is cancelled."
              />
            )}
            {data?.warnings.map((warning) => (
              <Alert key={warning} type="warning" showIcon title={warning} />
            ))}
            {data?.updatedAt && (
              <p className="metadata-save-state" role="status">
                Saved {dateTime(data.updatedAt)}
                {dirty && <Tag color="warning">Unsaved changes</Tag>}
              </p>
            )}
            {!data?.updatedAt && dirty && <p role="status">Unsaved changes</p>}
            {!fields.length && (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="No metadata yet. Extract all pages or add a field."
              />
            )}
            {fields.map((field, index) => (
              <div
                className="metadata-field"
                id={`metadata-${field.id}`}
                key={field.id || `new-${index}`}
              >
                <div className="metadata-field-heading">
                  <Select
                    showSearch
                    optionFilterProp="label"
                    aria-label={`Field ${index + 1} type`}
                    value={field.type}
                    disabled={!canManage || !!working}
                    onChange={(type) => edit(index, { type })}
                    options={Object.entries(types)
                      .filter(
                        ([value]) =>
                          metadataPath || !['document_type', 'physical_location'].includes(value),
                      )
                      .map(([value, label]) => ({ value, label }))}
                  />
                  {!!field.pageCount && (
                    <Tag>
                      {field.pageCount} {field.pageCount === 1 ? 'page' : 'pages'} ·{' '}
                      {field.occurrences} occurrences
                    </Tag>
                  )}
                  {metadataPath && (
                    <Tag color={field.verification === 'verified' ? 'success' : 'default'}>
                      {field.verification === 'verified' ? 'Verified' : 'Needs review'}
                    </Tag>
                  )}
                  {canVerify && (
                    <Button
                      disabled={!!working}
                      onClick={() => edit(index, { verification: 'verified' })}
                    >
                      Verify
                    </Button>
                  )}
                  {canManage && (
                    <IconButton
                      label={`Remove field ${index + 1}`}
                      icon={<DeleteOutlined />}
                      disabled={!!working}
                      onClick={() => {
                        setFields((current) => current.filter((_, i) => i !== index));
                        setDirty(true);
                      }}
                    />
                  )}
                </div>
                <Input.TextArea
                  aria-label={`Field ${index + 1} value`}
                  value={field.value}
                  maxLength={2000}
                  autoSize={{ minRows: 1, maxRows: 6 }}
                  readOnly={!canManage}
                  disabled={!!working}
                  onChange={(event) => edit(index, { value: event.target.value })}
                />
                <Input
                  aria-label={`Field ${index + 1} context`}
                  value={field.context}
                  placeholder="Role, party, date type or other context"
                  maxLength={240}
                  readOnly={!canManage}
                  disabled={!!working}
                  onChange={(event) => edit(index, { context: event.target.value })}
                />
                {metadataPath && (
                  <span className="metadata-provenance">
                    {field.origin === 'manual'
                      ? 'Manual entry'
                      : field.origin === 'corrected'
                        ? 'Human correction'
                        : 'Machine suggestion'}
                    {field.editedAt
                      ? ` · Edited by ${field.editedByName || 'operator'} · ${dateTime(field.editedAt)}`
                      : ''}
                    {field.verifiedAt
                      ? ` · Verified by ${field.verifiedByName || 'QC'} · ${dateTime(field.verifiedAt)}`
                      : ''}
                  </span>
                )}
                {field.sourceStale && (
                  <Alert
                    type="warning"
                    title="Source OCR/image changed or a page was excluded. Verify this value against the current document."
                  />
                )}
                {!!field.candidates?.length && (
                  <div className="metadata-candidates">
                    <span className="qc-field-label">Suggested values</span>
                    <Space wrap size={[4, 4]}>
                      {field.candidates.map((candidate, i) => (
                        <Button
                          key={`${candidate.id}-${i}`}
                          disabled={!canManage}
                          onClick={() =>
                            edit(index, {
                              value: candidate.value,
                              candidateId: candidate.id,
                              verification: 'needs_review',
                            })
                          }
                        >
                          {candidate.value}
                        </Button>
                      ))}
                    </Space>
                  </div>
                )}
                {field.normalized && field.type === 'date' && !dirty && (
                  <span className="muted">Normalized date: {field.normalized}</span>
                )}
                {field.alternatives?.length > 1 && (
                  <div className="metadata-alternatives">
                    <span className="muted">Possible spellings · verify before choosing</span>
                    {field.alternatives.map((alt) => (
                      <Button
                        key={alt.value}
                        size="small"
                        disabled={!canManage || !!working}
                        onClick={() => edit(index, { value: alt.value })}
                      >
                        {alt.value} · {alt.pages.length} pages / {alt.count} occurrences
                      </Button>
                    ))}
                  </div>
                )}
                {!!field.source?.length && (
                  <details
                    className="metadata-evidence"
                    open={
                      expandedEvidence && field.id ? expandedEvidence.includes(field.id) : undefined
                    }
                    onToggle={(event) => {
                      if (
                        field.id &&
                        expandedEvidence &&
                        event.currentTarget.open !== expandedEvidence.includes(field.id)
                      )
                        onEvidenceToggle?.(field.id, event.currentTarget.open);
                    }}
                  >
                    <summary>
                      Source evidence
                      {field.originalValue && field.originalValue !== field.value
                        ? ' · value edited'
                        : ''}
                    </summary>
                    {field.source.map((source, i) => (
                      <div key={`${source.resultId}-${source.index}-${i}`}>
                        <Button type="link" size="small" onClick={() => onSource(source)}>
                          Page {pageNumbers[source.pageId] ?? source.pageNumber}
                        </Button>
                        <span>{source.text}</span>
                      </div>
                    ))}
                  </details>
                )}
              </div>
            ))}
            {canManage && (
              <Button
                className="metadata-add-field"
                icon={<PlusOutlined aria-hidden />}
                disabled={!data || !!working || fields.length >= 200}
                onClick={() => {
                  setFields((current) => [
                    ...current,
                    { id: null, type: 'other', value: '', context: '' },
                  ]);
                  setDirty(true);
                }}
              >
                Add field
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
