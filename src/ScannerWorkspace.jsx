import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Empty,
  Pagination,
  Segmented,
  Select,
  Modal,
  Space,
  Splitter,
} from 'antd';
import {
  DeleteOutlined,
  MenuOutlined,
  ReloadOutlined,
  RotateLeftOutlined,
  RotateRightOutlined,
  ScanOutlined,
  SettingOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import PageViewer from './PageViewer';
import { IconButton, Thumbnail, useNarrow } from './ui';

export default function ScannerWorkspace({
  requestedMode,
  state,
  busy,
  requesting,
  networkError,
  scenario,
  setScenario,
  pageDelay,
  onAction,
  onSettings,
  onPageAction,
  sessions = [],
  locked = false,
  initialPageId = null,
  onReplacement,
}) {
  const [selected, setSelected] = useState(initialPageId);
  const [placement, setPlacement] = useState('append');
  const [replacement, setReplacement] = useState(false);
  const [candidateId, setCandidateId] = useState(null);
  const [sessionKey, setSessionKey] = useState('all');
  const [listPage, setListPage] = useState(1);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  const [lastRemoved, setLastRemoved] = useState(null);
  const narrow = useNarrow();
  const scanner = state.scanner;
  const totalPages = state.pageDetails.filter((page) => !page.excluded).length;
  const hasRemoved = state.pageDetails.some((page) => page.excluded);
  const undoPage = state.pageDetails.find((page) => page.id === lastRemoved && page.excluded);
  const simulator = scanner.mode === 'simulator';
  const pages = state.pageDetails.filter(
    (page) =>
      (showRemoved || !page.excluded) && (sessionKey === 'all' || page.sessionId === sessionKey),
  );
  const currentListPage = Math.min(listPage, Math.max(1, Math.ceil(pages.length / 50)));
  const page = pages.find((page) => page.id === selected) || pages[0];
  const pending = sessions.find(
    (s) => s.replacement_status === 'pending' && s.status !== 'running',
  );
  const candidates = pending ? state.pageDetails.filter((p) => p.sessionId === pending.id) : [];
  useEffect(() => {
    if (state.job?.id) {
      setSessionKey('all');
      setSelected(initialPageId);
      setListPage(1);
    }
  }, [state.job?.id, state.job?.provider, initialPageId]);
  const scanning = state.status === 'scanning' || requesting === 'scan';
  const scanDisabled =
    locked ||
    !!pending ||
    busy ||
    !scanner.canScan ||
    !!networkError ||
    (simulator && (!Number.isInteger(pageDelay) || pageDelay < 0 || pageDelay > 10000));
  const feedback =
    networkError ||
    (!locked && (state.error || (!scanner.canScan && !busy ? scanner.message : null)));
  async function restorePage(target) {
    if (await onPageAction(target, 'restore')) {
      setLastRemoved(null);
      setSelected(target.id);
    }
  }
  const history = (
    <section className="panel page-history" aria-label="Batch pages">
      <div className="panel-heading">
        <h2>Captured pages</h2>
        <span className="muted" aria-label="Captured page count">
          {totalPages}
        </span>
      </div>
      <div className="panel-tools">
        <Select
          aria-label="Scan session"
          className="fill-width"
          value={sessionKey}
          onChange={(key) => {
            setSessionKey(key);
            setSelected(null);
            setListPage(1);
          }}
          options={[
            { value: 'all', label: 'All sessions' },
            ...sessions.map((session) => ({
              value: session.id,
              label: `Session ${String(session.session_number).padStart(3, '0')} · ${state.pageDetails.filter((page) => page.sessionId === session.id && !page.excluded).length} pages · ${session.status}`,
            })),
          ]}
        />
        {hasRemoved && (
          <div className="page-list-actions">
            <Checkbox
              checked={showRemoved}
              onChange={(event) => setShowRemoved(event.target.checked)}
            >
              Show removed
            </Checkbox>
            {undoPage && !locked && (
              <Button
                size="small"
                type="link"
                disabled={busy}
                onClick={() => restorePage(undoPage)}
              >
                Undo removal
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="scroll-region scanner-page-list" aria-label="Captured page list">
        {pages.length ? (
          pages.slice((currentListPage - 1) * 50, currentListPage * 50).map((item) => (
            <Button
              key={item.id}
              type="text"
              block
              className={`page-item scanner-page ${item.id === page?.id ? 'selected' : ''} ${item.excluded ? 'removed' : ''}`}
              aria-pressed={item.id === page?.id}
              aria-label={`Inspect ${item.excluded ? 'removed ' : ''}page ${item.pageNumber}`}
              onClick={() => setSelected(item.id)}
            >
              <Thumbnail
                src={`/api/pages/${item.id}/thumbnail`}
                label={`Page ${item.pageNumber} thumbnail`}
                rotation={item.rotation}
              />
              <span className="page-item-info">
                <strong>Page {item.pageNumber}</strong>
                <span className="muted">Session {item.sessionNumber}</span>
                {item.excluded && <span>Removed</span>}
              </span>
            </Button>
          ))
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={scanning ? 'Waiting for the first page' : 'No captured pages'}
          />
        )}
      </div>
      {pages.length > 50 && (
        <div className="panel-footer">
          <Pagination
            simple
            size="small"
            current={currentListPage}
            pageSize={50}
            total={pages.length}
            onChange={setListPage}
          />
        </div>
      )}
    </section>
  );
  const preview = (
    <section className="panel preview-panel">
      <div className="panel-heading">
        <h1>{page ? `Page ${page.pageNumber}` : 'Document preview'}</h1>
        {narrow && locked && (
          <IconButton
            label="Show batch pages"
            icon={<MenuOutlined />}
            onClick={() => setHistoryOpen(true)}
          />
        )}
        {page && (
          <Space size={4}>
            {page.excluded && <span className="muted">Removed</span>}
            {!locked && (
              <>
                <IconButton
                  label="Rotate left"
                  icon={<RotateLeftOutlined />}
                  disabled={busy || page.excluded}
                  onClick={() => onPageAction(page, 'rotate-left')}
                />
                <IconButton
                  label="Rotate right"
                  icon={<RotateRightOutlined />}
                  disabled={busy || page.excluded}
                  onClick={() => onPageAction(page, 'rotate-right')}
                />
                {page.excluded ? (
                  <IconButton
                    label="Restore page"
                    icon={<UndoOutlined />}
                    disabled={busy}
                    onClick={() => restorePage(page)}
                  />
                ) : (
                  <IconButton
                    label="Remove page"
                    icon={<DeleteOutlined />}
                    danger
                    disabled={busy}
                    onClick={async () => {
                      if (await onPageAction(page, 'remove')) setLastRemoved(page.id);
                    }}
                  />
                )}
                <Button
                  disabled={busy || !!pending || page.excluded}
                  onClick={() => {
                    setSelected(page.id);
                    setReplacement(true);
                  }}
                >
                  Replace Page
                </Button>
              </>
            )}
          </Space>
        )}
      </div>
      <PageViewer
        image={page ? { imageId: page.id } : null}
        label={page ? `Page ${page.pageNumber}` : 'Scan preview'}
        previewUrl={page && `/api/pages/${page.id}/preview`}
        originalUrl={page?.imageUrl}
        rotation={page?.rotation || 0}
      />
    </section>
  );
  return (
    <section className="workspace scanner-workspace" aria-label="Scanner">
      {!locked && (
        <div className="workspace-toolbar scanner-toolbar" aria-label="Scanner controls">
          <Segmented
            aria-label="Scanner Mode"
            value={requestedMode || scanner.mode || 'simulator'}
            disabled={busy}
            onChange={(mode) => onAction('mode', { mode })}
            options={[
              { label: 'Simulator', value: 'simulator' },
              { label: 'Real Hardware', value: 'real' },
            ]}
          />
          {simulator ? (
            <>
              <Select
                aria-label="Simulation Scenario"
                className="scenario-select"
                value={scenario}
                disabled={busy}
                onChange={setScenario}
                options={scanner.scenarios?.map((item) => ({ value: item.id, label: item.name }))}
              />
            </>
          ) : (
            <>
              <Select
                aria-label="Scanner Device"
                prefix="Device"
                className="scanner-select"
                value={scanner.selectedDeviceId || ''}
                disabled={busy || !scanner.devices?.length}
                onChange={(deviceId) => onAction('refresh', { deviceId: deviceId || null })}
                options={[
                  { value: '', label: 'Automatic · Match selected profile' },
                  ...(scanner.devices || []).map((item) => ({
                    value: item.id,
                    label: `${item.name}${scanner.devices.filter((device) => device.name === item.name).length > 1 ? ` · ${item.id}` : ''}`,
                  })),
                ]}
              />
              <Select
                aria-label="Scanner Profile"
                prefix="Profile"
                className="scanner-select"
                value={scanner.profileId}
                disabled={busy || !scanner.profiles?.length}
                onChange={(profileId) => onAction('refresh', { profileId, deviceId: null })}
                options={scanner.profiles?.map((item) => ({
                  value: item.id,
                  label: `${item.name} · ${item.source === 'digitalarch' ? 'DigitalArch' : 'NAPS2'}${item.compatible ? '' : ' (unsupported)'}`,
                  disabled: !item.compatible,
                }))}
              />
            </>
          )}
          <Space className="toolbar-actions" size={4}>
            {narrow && (
              <IconButton
                label="Show batch pages"
                icon={<MenuOutlined />}
                onClick={() => setHistoryOpen(true)}
              />
            )}
            <IconButton
              label="Refresh Scanner"
              icon={<ReloadOutlined />}
              disabled={busy}
              onClick={() => onAction('refresh')}
            />
            <IconButton
              label="Advanced scanner settings"
              icon={<SettingOutlined />}
              onClick={onSettings}
            />
            <Button
              type="primary"
              icon={<ScanOutlined aria-hidden />}
              loading={scanning || requesting === 'scan'}
              disabled={scanDisabled}
              onClick={() =>
                onAction('scan', {
                  options: simulator ? { scenario, pageDelay } : {},
                  placement,
                  anchorPageId: placement === 'append' ? null : page?.id,
                })
              }
            >
              Scan feeder
            </Button>
          </Space>
          <Select
            aria-label="New page placement"
            value={placement}
            disabled={busy || !!pending}
            onChange={setPlacement}
            options={[
              { value: 'append', label: 'Append to end' },
              { value: 'before', label: 'Insert before selected', disabled: !page },
              { value: 'after', label: 'Insert after selected', disabled: !page },
            ]}
          />
        </div>
      )}
      {((!locked && requestedMode) || feedback) && (
        <div className="feedback" role="status" aria-live="polite">
          {requestedMode ? (
            <Alert
              type="info"
              showIcon
              title={
                requestedMode === 'real'
                  ? 'Checking real hardware… First setup may take longer; no scan is started.'
                  : 'Switching to simulator…'
              }
            />
          ) : null}
          {!requestedMode && feedback && <Alert type="error" showIcon title={feedback} />}
        </div>
      )}
      {narrow ? (
        <div className="narrow-preview">{preview}</div>
      ) : (
        <Splitter className="workstation-split">
          <Splitter.Panel defaultSize="24%" min={200} max="40%">
            {history}
          </Splitter.Panel>
          <Splitter.Panel min={300}>{preview}</Splitter.Panel>
        </Splitter>
      )}
      <Modal
        title={`Replace page ${page?.pageNumber || ''}`}
        open={replacement}
        onCancel={() => setReplacement(false)}
        okText="Scan replacement candidates"
        okButtonProps={{ disabled: scanDisabled }}
        onOk={() => {
          setReplacement(false);
          onAction('scan', {
            options: simulator ? { scenario, pageDelay } : {},
            replacementPageId: page.id,
          });
        }}
      >
        <p>
          The active image remains unchanged until you preview and explicitly confirm a replacement.
          All feeder images are retained.
        </p>
      </Modal>
      <Modal
        title="Preview and confirm replacement"
        open={!!pending}
        footer={null}
        closable={false}
        width={760}
      >
        <Select
          aria-label="Replacement candidate"
          value={candidateId}
          placeholder="Choose a captured candidate explicitly"
          onChange={setCandidateId}
          options={candidates.map((p) => ({ value: p.id, label: `Candidate ${p.pageNumber}` }))}
        />
        {candidateId && candidates.some((p) => p.id === candidateId) && (
          <div className="replacement-preview">
            <PageViewer
              image={{ imageId: candidateId }}
              label="Replacement candidate"
              previewUrl={`/api/pages/${candidateId}/preview`}
              originalUrl={`/api/pages/${candidateId}/image`}
            />
          </div>
        )}
        {!candidates.length && (
          <Alert
            type="warning"
            title="No valid replacement was captured. Cancel to keep the current image unchanged."
          />
        )}
        <Space>
          <Button
            disabled={busy}
            onClick={() => {
              onReplacement(pending.id, null, true);
              setCandidateId(null);
            }}
          >
            Cancel replacement
          </Button>
          <Button
            type="primary"
            disabled={busy || !candidates.some((p) => p.id === candidateId)}
            onClick={() => {
              onReplacement(pending.id, candidateId, false);
              setCandidateId(null);
            }}
          >
            Confirm selected replacement
          </Button>
        </Space>
      </Modal>
      <Drawer
        title="Batch pages"
        placement="left"
        open={narrow && historyOpen}
        onClose={() => setHistoryOpen(false)}
        size={300}
        destroyOnHidden
        styles={{ body: { padding: 0, overflow: 'hidden' } }}
      >
        {history}
      </Drawer>
    </section>
  );
}
