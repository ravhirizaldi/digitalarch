import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Checkbox,
  ConfigProvider,
  Empty,
  Layout,
  Menu,
  Modal,
  Popconfirm,
  Progress,
  Spin,
  Space,
  Tag,
} from 'antd';
import {
  DatabaseOutlined,
  FileTextOutlined,
  KeyOutlined,
  LogoutOutlined,
  ScanOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  HistoryOutlined,
  AuditOutlined,
} from '@ant-design/icons';
import { enterpriseTheme } from './theme';
import { api, setCsrfToken } from './api';
import { matchRoute, permittedRoute, routePath } from './routes';
import { IconButton, statusLabels } from './ui';
import ScannerSettings from './ScannerSettings';
import ScannerWorkspace from './ScannerWorkspace';
import AuthScreen from './AuthScreen';
import BatchList from './BatchList';
import BatchInfo from './BatchInfo';
import StaffNotifications from './StaffNotifications';
import './style.css';

const Administration = lazy(() => import('./Administration'));
const OcrWorkspace = lazy(() => import('./OcrWorkspace'));
const OcrSettings = lazy(() => import('./OcrSettings'));
const QcWorkspace = lazy(() => import('./QcWorkspace'));
const QcQueue = lazy(() => import('./QcWorkspace').then((module) => ({ default: module.QcQueue })));
const Documents = lazy(() => import('./Documents'));
const ApprovalDocument = lazy(() => import('./ApprovalDocument'));
const ApprovalConfirmation = lazy(() => import('./ApprovalConfirmation'));
const ViewerWorkspace = lazy(() => import('./ViewerWorkspace'));
const ViewerRegistrations = lazy(() => import('./ViewerRegistrations'));

function DigitalArchApp() {
  const [identity, setIdentity] = useState(null);
  const [initializing, setInitializing] = useState(true);
  const [view, setView] = useState('home');
  const [scanner, setScanner] = useState({});
  const [active, setActive] = useState(null);
  const [ocrJobId, setOcrJobId] = useState(null);
  const [documentBatchId, setDocumentBatchId] = useState(null);
  const [documentStatus, setDocumentStatus] = useState(null);
  const [ocrStatus, setOcrStatus] = useState(null);
  const [capturePageId, setCapturePageId] = useState(null);
  const [ocrMetadataDirty, setOcrMetadataDirty] = useState(false);
  const activeId = useRef(null);
  const currentLocation = useRef(window.location.pathname + window.location.search);
  const navigatingHistory = useRef(false);
  const [working, setWorking] = useState('');
  const [requestedMode, setRequestedMode] = useState(null);
  const [error, setError] = useState('');
  const [scenario, setScenario] = useState('multi');
  const [pageDelay, setPageDelay] = useState(500);
  const [settings, setSettings] = useState(false);
  const [info, setInfo] = useState(false);
  const [locationDraft, setLocationDraft] = useState('');
  const [complete, setComplete] = useState(false);
  const [acknowledge, setAcknowledge] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [cancellingScan, setCancellingScan] = useState(false);
  const cancelBeforeCapture = useRef(false);
  const [cancelledSession, setCancelledSession] = useState(null);
  const user = identity?.user;
  const can = useCallback((permission) => !!user?.permissions.includes(permission), [user]);
  const operational = can('batches:create');
  const activeCapture = active?.sessions.find(
    (session) => session.status === 'running' && session.created_by === user?.id,
  );
  const capture = scanner.capture?.created_by === user?.id ? scanner.capture : activeCapture;
  const scanLocked = !!capture || working === 'scan';
  const stoppingScan = !!capture && (capture.cancelRequested || cancelledSession === capture.id);
  const finalizingScan =
    !!capture?.jobStatus && !['scanning', 'unknown'].includes(capture.jobStatus);
  const capturedPages = Math.max(
    capture?.page_count || 0,
    activeCapture?.id === capture?.id ? activeCapture?.page_count || 0 : 0,
  );
  const locked = active && !['in_progress', 'paused'].includes(active.batch.status);
  const busy = !!working || scanLocked || scanner.busy || scanner.checking;
  const ocrFooter = view === 'ocr' && ocrStatus?.jobId === ocrJobId ? ocrStatus : null;
  const partial = active?.sessions.some((session) =>
    ['partial', 'interrupted'].includes(session.status),
  );

  const clearBatch = useCallback(() => {
    activeId.current = null;
    setActive(null);
    setInfo(false);
    setComplete(false);
  }, []);
  const showView = useCallback((next, batchId = null, replace = false) => {
    if (next === 'ocr') setOcrJobId(batchId);
    if (['document', 'record', 'confirmation'].includes(next)) setDocumentBatchId(batchId);
    const destination = new URL(routePath(next, batchId), window.location.origin);
    if (
      destination.pathname === window.location.pathname ||
      (replace && matchRoute(window.location.pathname)?.view === next)
    )
      destination.search = window.location.search;
    else if (
      (next === 'document' &&
        ['/qc', '/batches', '/capture', '/admin/batches'].includes(window.location.pathname)) ||
      (next === 'record' && ['/documents', '/approvals'].includes(window.location.pathname)) ||
      (next === 'confirmation' && window.location.pathname.startsWith('/records/')) ||
      (next === 'ocr' && batchId && window.location.pathname === '/ocr')
    )
      destination.searchParams.set('returnTo', window.location.pathname + window.location.search);
    else {
      const returnTo = new URLSearchParams(window.location.search).get('returnTo');
      if (returnTo === destination.pathname || returnTo?.startsWith(destination.pathname + '?'))
        destination.search = new URL(returnTo, window.location.origin).search;
    }
    if (
      window.location.pathname + window.location.search !==
      destination.pathname + destination.search
    )
      window.history[replace ? 'replaceState' : 'pushState'](
        null,
        '',
        destination.pathname + destination.search,
      );
    currentLocation.current = destination.pathname + destination.search;
    setView(next);
  }, []);
  useEffect(() => {
    const remember = () => {
      currentLocation.current = window.location.pathname + window.location.search;
    };
    window.addEventListener('digitalarch:url-state', remember);
    return () => window.removeEventListener('digitalarch:url-state', remember);
  }, []);
  const restoreRoute = useCallback(
    async (account, requested = matchRoute(window.location.pathname), replace = true) => {
      const route = permittedRoute(account, requested);
      setWorking('restore');
      setError('');
      try {
        if (route.batchId) {
          let result = await api(`/api/batches/${route.batchId}`);
          if (result.batch.status === 'paused')
            result = await api(`/api/batches/${route.batchId}/resume`, {
              version: result.batch.version,
            });
          activeId.current = result.batch.id;
          setActive(result);
          const session = result.sessions.at(-1);
          if (session?.scanner_mode === 'simulator') {
            if (session.settings_snapshot?.scenario)
              setScenario(session.settings_snapshot.scenario);
            if (Number.isInteger(session.settings_snapshot?.pageDelay))
              setPageDelay(session.settings_snapshot.pageDelay);
          }
          showView('scanner', result.batch.id, replace);
        } else {
          clearBatch();
          showView(
            route.view,
            route.jobId || route.documentBatchId || route.recordId || route.confirmationId || null,
            replace,
          );
        }
        return true;
      } catch (error) {
        setError(error.message);
        clearBatch();
        const fallback = permittedRoute(account, null).view;
        if (error.status === 503) setView(fallback);
        else showView(fallback, null, true);
      } finally {
        setWorking('');
      }
    },
    [clearBatch, showView],
  );
  const authenticated = useCallback(
    async (result) => {
      setIdentity(result);
      setCsrfToken(result.csrfToken);
      setChangingPassword(false);
      clearBatch();
      setError('');
      if (!result.user.must_change_password) await restoreRoute(result.user);
    },
    [clearBatch, restoreRoute],
  );
  useEffect(() => {
    api('/api/auth/me')
      .then(authenticated)
      .catch((error) => {
        if (error.status !== 401) setError(error.message);
      })
      .finally(() => setInitializing(false));
    const expired = () => {
      setIdentity(null);
      setCsrfToken('');
      clearBatch();
      setError('Your session expired. Sign in again.');
    };
    window.addEventListener('auth-expired', expired);
    return () => window.removeEventListener('auth-expired', expired);
  }, [authenticated, clearBatch]);

  const refresh = useCallback(async () => {
    try {
      if (can('scanner:read')) setScanner(await api('/api/scanner/status'));
      const id = activeId.current;
      if (id) {
        const result = await api(`/api/batches/${id}`);
        if (activeId.current === id)
          setActive((current) =>
            !current || result.batch.version >= current.batch.version ? result : current,
          );
      }
    } catch (error) {
      setError(error.message);
      if (activeId.current && [403, 404].includes(error.status)) {
        clearBatch();
        showView('batches');
      }
    }
  }, [can, clearBatch, showView]);
  const hasActive = !!active || !!capture;
  useEffect(() => {
    if (!user || user.must_change_password) return;
    refresh();
    const timer = setInterval(
      () => {
        if (!document.hidden) refresh();
      },
      hasActive ? 1000 : 15000,
    );
    return () => clearInterval(timer);
  }, [user, refresh, hasActive]);
  useEffect(() => {
    if (!scanLocked) return;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [scanLocked]);
  useEffect(() => {
    if (!user || user.must_change_password) return;
    const pop = async () => {
      const currentPath = currentLocation.current;
      if (busy || navigatingHistory.current) {
        window.history.pushState(null, '', currentPath);
        window.dispatchEvent(new Event('digitalarch:url-state'));
        return;
      }
      if (ocrMetadataDirty && !window.confirm('Discard unsaved metadata edits?')) {
        window.history.pushState(null, '', currentPath);
        window.dispatchEvent(new Event('digitalarch:url-state'));
        return;
      }
      if (new URL(currentPath, window.location.origin).pathname === window.location.pathname) {
        currentLocation.current = window.location.pathname + window.location.search;
        window.dispatchEvent(new Event('digitalarch:url-state'));
        return;
      }
      const requested = matchRoute(window.location.pathname);
      navigatingHistory.current = true;
      try {
        if (active && !locked && requested?.batchId !== active.batch.id)
          await api(`/api/batches/${active.batch.id}/pause`, { version: active.batch.version });
        await restoreRoute(user, requested);
      } catch (error) {
        setError(error.message);
        window.history.pushState(null, '', currentPath);
        window.dispatchEvent(new Event('digitalarch:url-state'));
      } finally {
        navigatingHistory.current = false;
      }
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [user, busy, active, locked, view, ocrJobId, documentBatchId, ocrMetadataDirty, restoreRoute]);

  async function run(label, operation) {
    if (working || scanLocked) return;
    setWorking(label);
    setError('');
    try {
      return await operation();
    } catch (error) {
      setError(error.message);
      await refresh();
    } finally {
      setWorking('');
    }
  }
  async function newBatch() {
    if (busy) return;
    await leave('scanner');
  }
  async function openBatch(batch, selectedPageId = null) {
    await run('resume', async () => {
      const result =
        batch.status === 'capture_completed'
          ? await api(`/api/batches/${batch.id}`)
          : await api(`/api/batches/${batch.id}/resume`, { version: batch.version });
      clearBatch();
      activeId.current = result.batch.id;
      setActive(result);
      setCapturePageId(selectedPageId);
      showView('scanner', result.batch.id);
    });
  }
  async function leave(next = 'home', nextId = null) {
    await run('pause', async () => {
      if (active && !locked)
        await api(`/api/batches/${active.batch.id}/pause`, { version: active.batch.version });
      clearBatch();
      showView(next, nextId);
    });
  }
  function navigate(next, nextId = null) {
    if (busy) return;
    if (ocrMetadataDirty && !window.confirm('Discard unsaved metadata edits?')) return;
    if (active && next !== 'scanner') leave(next, nextId);
    else {
      setError('');
      showView(next, next === 'scanner' ? active?.batch.id : nextId);
    }
  }
  function backFromDocument() {
    const returnTo = new URLSearchParams(window.location.search).get('returnTo');
    const origin = returnTo?.split('?')[0];
    const route = ['/qc', '/batches', '/capture', '/admin/batches'].includes(origin)
      ? permittedRoute(user, matchRoute(origin)).view
      : can('qc:read')
        ? 'qc'
        : 'batches';
    navigate(route);
  }
  const openConfirmation = (id) => navigate('confirmation', id);
  async function openNotification(destination) {
    if (busy || !destination) return false;
    if (ocrMetadataDirty && !window.confirm('Discard unsaved document edits?')) return false;
    return await run('open-notification', async () => {
      if (
        active &&
        !locked &&
        (destination.view !== 'scanner' || active.batch.id !== destination.id)
      )
        await api(`/api/batches/${active.batch.id}/pause`, { version: active.batch.version });
      return restoreRoute(user, matchRoute(routePath(destination.view, destination.id)), false);
    });
  }
  function backFromRecord() {
    const returnTo = new URLSearchParams(window.location.search).get('returnTo');
    const origin = returnTo?.split('?')[0];
    const requested =
      origin && (['/documents', '/approvals'].includes(origin) || origin.startsWith('/records/'))
        ? matchRoute(origin)
        : { view: 'documents' };
    const route = permittedRoute(user, requested);
    showView(route.view, route.recordId || null);
  }
  async function scannerAction(route, body = {}) {
    if (route === 'mode') setRequestedMode(body.mode);
    await run(route, async () => {
      if (route === 'scan') {
        let target = active;
        if (!target) {
          target = await api('/api/batches', {});
          activeId.current = target.batch.id;
          setActive(target);
          showView('scanner', target.batch.id);
        }
        if (cancelBeforeCapture.current) return;
        const result = await api(`/api/batches/${target.batch.id}/scan-sessions`, {
          version: target.batch.version,
          options: body.options || body,
          ...(body.options
            ? {
                placement: body.placement,
                anchorPageId: body.anchorPageId,
                replacementPageId: body.replacementPageId,
              }
            : {}),
        });
        if (activeId.current === result.batch.id) setActive(result);
        if (cancelBeforeCapture.current) {
          const session = result.sessions.find((session) => session.status === 'running');
          if (session) {
            await api(`/api/batches/${target.batch.id}/cancel-scan`, { sessionId: session.id });
            setCancelledSession(session.id);
          }
        }
      } else setScanner(await api(`/api/scanner/${route}`, body));
      await refresh();
    });
    if (cancelBeforeCapture.current) {
      cancelBeforeCapture.current = false;
      setCancellingScan(false);
    }
    setRequestedMode(null);
  }
  async function cancelScan() {
    if (cancellingScan || stoppingScan || finalizingScan) return;
    if (!capture) {
      if (working === 'scan') {
        cancelBeforeCapture.current = true;
        setCancellingScan(true);
      }
      return;
    }
    setCancellingScan(true);
    setError('');
    try {
      const result = await api(`/api/batches/${capture.batch_id}/cancel-scan`, {
        sessionId: capture.id,
      });
      setCancelledSession(capture.id);
      if (activeId.current === result.batch.id) setActive(result);
      await refresh();
    } catch (error) {
      setError(error.message);
    } finally {
      setCancellingScan(false);
    }
  }
  const changePage = (page, action, label) =>
    run('page', async () => {
      const result = await api(
        `/api/pages/${page.id}`,
        { version: active.batch.version, action, ...(action === 'rename' ? { label } : {}) },
        'PATCH',
      );
      if (activeId.current === result.batch.id) setActive(result);
      return result;
    });
  const latest = active?.sessions.at(-1);
  const scannerState = {
    scanner,
    status:
      latest?.status === 'running'
        ? 'scanning'
        : latest?.status === 'completed'
          ? 'complete'
          : latest
            ? 'error'
            : 'idle',
    error: latest?.error_summary,
    job: latest
      ? { id: latest.id, capturedPages: latest.page_count, provider: latest.scanner_mode }
      : null,
    pageDetails: (active?.pages || []).map((page) => ({
      id: page.id,
      page_number: page.page_number,
      page_label: page.page_label,
      capture_order: page.capture_order,
      replacement_candidate: page.replacement_candidate,
      qcProtected: active.operator_locks?.reviewedPageIds.includes(page.id),
      rotation: page.rotation_degrees,
      excluded: page.is_excluded,
      sessionId: page.scan_session_id,
      sessionNumber: active.sessions.find((session) => session.id === page.scan_session_id)
        ?.session_number,
      imageUrl: `/api/pages/${page.id}/image`,
    })),
  };
  const items = [
    ...(operational
      ? [
          { key: 'home', label: 'Capture Workspace', icon: <ScanOutlined aria-hidden /> },
          { key: 'batches', label: 'My Batches', icon: <FileTextOutlined aria-hidden /> },
          { key: 'scanner', label: 'Scanner', icon: <ScanOutlined aria-hidden /> },
        ]
      : []),
    ...(can('users:read')
      ? [{ key: 'users', label: 'Users', icon: <TeamOutlined aria-hidden /> }]
      : []),
    ...(can('viewers:approve')
      ? [
          {
            key: 'viewerRequests',
            label: 'Viewer registrations',
            icon: <TeamOutlined aria-hidden />,
          },
        ]
      : []),
    ...(can('archive:read') && !can('documents:read')
      ? [{ key: 'viewer', label: 'Documents', icon: <FileTextOutlined aria-hidden /> }]
      : []),
    ...(can('ocr:read')
      ? [{ key: 'ocr', label: 'OCR Processing', icon: <FileTextOutlined aria-hidden /> }]
      : []),
    ...(can('qc:read')
      ? [{ key: 'qc', label: 'QC Queue', icon: <FileTextOutlined aria-hidden /> }]
      : []),
    ...(can('documents:read')
      ? [{ key: 'documents', label: 'Documents', icon: <FileTextOutlined aria-hidden /> }]
      : []),
    ...(can('approval_l1:review') || can('approval_l2:review')
      ? [
          {
            key: 'approvals',
            label: can('approval_l1:review') ? 'L1 approvals' : 'L2 approvals',
            icon: <FileTextOutlined aria-hidden />,
          },
        ]
      : []),
    ...(can('batches:reassign')
      ? [{ key: 'assignments', label: 'Batch assignments', icon: <FileTextOutlined aria-hidden /> }]
      : []),
    ...(can('audit:read')
      ? [{ key: 'audit', label: 'Audit Logs', icon: <DatabaseOutlined aria-hidden /> }]
      : []),
    ...(can('system:read')
      ? [{ key: 'system', label: 'System', icon: <SettingOutlined aria-hidden /> }]
      : []),
    ...(can('settings:read')
      ? [{ key: 'settings', label: 'Settings', icon: <SettingOutlined aria-hidden /> }]
      : []),
  ];
  if (initializing)
    return (
      <div className="loading-state">
        <Spin description="Opening DigitalArch" />
      </div>
    );
  if (!user) return <AuthScreen onAuthenticated={authenticated} initialError={error} />;
  if (user.must_change_password) return <AuthScreen user={user} onAuthenticated={authenticated} />;
  return (
    <Layout className="app-shell" inert={scanLocked}>
      {changingPassword && (
        <AuthScreen
          user={user}
          onCancel={() => setChangingPassword(false)}
          onAuthenticated={(result) => {
            setIdentity(result);
            setCsrfToken(result.csrfToken);
            setChangingPassword(false);
          }}
        />
      )}
      <Layout.Header className="app-header">
        <span className="brand">
          <ScanOutlined /> DigitalArch
        </span>
        <span className="header-module">
          {view === 'viewer'
            ? 'Published library'
            : can('users:read') && !operational
              ? 'Administration'
              : 'Document capture'}
        </span>
        <div className="header-operational">
          {can('scanner:read') && (
            <Badge
              className="header-scanner-status"
              status={scanner.canScan ? 'success' : 'warning'}
              text={
                <span className="header-status">
                  {scanner.busy ? 'Scanning' : statusLabels[scanner.state] || 'Checking scanner'}
                </span>
              }
            />
          )}
          <span className="header-user" title={user.display_name}>
            <UserOutlined className="header-user-avatar" aria-hidden />
            <span className="header-user-name">{user.display_name}</span>
          </span>
          <div className="header-account-actions">
            {can('notifications:read') && !user.must_change_password && (
              <StaffNotifications
                key={user.id}
                user={user}
                onOpen={openNotification}
                disabled={busy}
              />
            )}
            <IconButton
              className="header-account-button"
              type="text"
              label="Change password"
              icon={<KeyOutlined aria-hidden />}
              disabled={busy || !!active || ocrMetadataDirty}
              onClick={() => setChangingPassword(true)}
            />
            <Button
              className="header-account-button header-sign-out"
              type="text"
              icon={<LogoutOutlined aria-hidden />}
              disabled={busy}
              onClick={() =>
                run('logout', async () => {
                  if (ocrMetadataDirty && !window.confirm('Discard unsaved metadata edits?'))
                    return;
                  if (active && !locked)
                    await api(`/api/batches/${active.batch.id}/pause`, {
                      version: active.batch.version,
                    });
                  await api('/api/auth/logout', {});
                  clearBatch();
                  setIdentity(null);
                  setCsrfToken('');
                  window.history.replaceState(null, '', '/');
                })
              }
            >
              Sign out
            </Button>
          </div>
        </div>
      </Layout.Header>
      {!!items.length && (
        <nav className="workspace-nav" aria-label="Workspace">
          <Menu
            mode="horizontal"
            disabled={busy}
            selectedKeys={[
              view === 'document'
                ? can('qc:read')
                  ? 'qc'
                  : 'batches'
                : ['record', 'confirmation'].includes(view)
                  ? 'documents'
                  : view,
            ]}
            items={items}
            onClick={({ key }) => navigate(key)}
          />
        </nav>
      )}
      <Layout.Content className="app-workspace">
        <div className="workspace">
          {error && (
            <Alert type="error" showIcon title={error} closable onClose={() => setError('')} />
          )}
          <Suspense
            fallback={
              <div className="loading-state">
                <Spin />
              </div>
            }
          >
            {view === 'home' || view === 'batches' ? (
              <BatchList
                key={view}
                home={view === 'home'}
                onNew={newBatch}
                onOpen={openBatch}
                onDocument={(id) => showView('document', id)}
                creating={!!working}
                userId={user.id}
              />
            ) : view === 'scanner' ? (
              !active ? (
                <>
                  <div className="workspace-toolbar batch-context">
                    <h1>No active batch</h1>
                    <span className="muted">A batch is created when you start scanning.</span>
                    <span className="toolbar-spacer" />
                    <Button disabled={busy} onClick={() => navigate('batches')}>
                      Open My Batches
                    </Button>
                  </div>
                  <ScannerWorkspace
                    requestedMode={requestedMode}
                    state={scannerState}
                    busy={busy}
                    requesting={working}
                    networkError=""
                    pageError={error}
                    scenario={scenario}
                    setScenario={setScenario}
                    pageDelay={pageDelay}
                    onAction={scannerAction}
                    onSettings={() => setSettings(true)}
                    onPageAction={changePage}
                  />
                </>
              ) : (
                <>
                  <div className="workspace-toolbar batch-context">
                    <div>
                      <h1 className="batch-context-identity">
                        <Tag icon={<DatabaseOutlined aria-hidden />}>{active.batch.batch_code}</Tag>
                        {latest && (
                          <Tag
                            icon={<ScanOutlined aria-hidden />}
                            aria-label="Current scan session"
                          >
                            Session {latest.session_number}
                          </Tag>
                        )}
                      </h1>
                      {active.batch.physical_location && (
                        <span className="muted">{active.batch.physical_location}</span>
                      )}
                    </div>
                    <span className="toolbar-spacer" />
                    <Button disabled={busy} onClick={() => leave('document', active.batch.id)}>
                      {['capturing', 'operator_preparation', 'rework'].includes(
                        active.batch.workflow_status,
                      )
                        ? 'Prepare document'
                        : 'View document'}
                    </Button>
                    {locked ? (
                      <Tag color="success">Capture completed · Read-only</Tag>
                    ) : (
                      <Button
                        disabled={busy}
                        onClick={() => {
                          setLocationDraft(active.batch.physical_location || '');
                          setInfo(true);
                        }}
                      >
                        Batch Info
                      </Button>
                    )}
                    {locked && can('ocr:manage') && (
                      <Button
                        type={active.batch.ocr_job_id ? 'default' : 'primary'}
                        loading={working === 'ocr'}
                        disabled={busy}
                        onClick={() =>
                          run('ocr', async () => {
                            const id =
                              active.batch.ocr_job_id ||
                              (await api(`/api/batches/${active.batch.id}/ocr`, {})).job.id;
                            clearBatch();
                            showView('ocr', id);
                          })
                        }
                      >
                        {active.batch.ocr_job_id ? 'Open OCR' : 'Send to OCR'}
                      </Button>
                    )}
                    <Button disabled={busy} onClick={() => leave()}>
                      {locked ? 'Back to My Batches' : 'Save & Exit'}
                    </Button>
                    {!locked && (
                      <Button
                        type="primary"
                        disabled={busy || !active.batch.page_count}
                        onClick={() => {
                          setAcknowledge(false);
                          setComplete(true);
                        }}
                      >
                        Complete Capture
                      </Button>
                    )}
                  </div>
                  <ScannerWorkspace
                    key={active.batch.id}
                    requestedMode={requestedMode}
                    state={scannerState}
                    busy={busy}
                    requesting={working}
                    networkError=""
                    pageError={error}
                    scenario={scenario}
                    setScenario={setScenario}
                    pageDelay={pageDelay}
                    onAction={scannerAction}
                    onSettings={() => setSettings(true)}
                    onPageAction={changePage}
                    sessions={active.sessions}
                    locked={locked}
                    reviewLocks={active.operator_locks}
                    initialPageId={capturePageId}
                    onReplacement={(sessionId, candidateId, cancel) =>
                      run('replacement', async () => {
                        setActive(
                          await api(`/api/batches/${active.batch.id}/replacement`, {
                            version: active.batch.version,
                            sessionId,
                            candidateId,
                            cancel,
                          }),
                        );
                      })
                    }
                  />
                </>
              )
            ) : view === 'ocr' ? (
              <OcrWorkspace
                user={user}
                metadataDirty={ocrMetadataDirty}
                onMetadataDirty={setOcrMetadataDirty}
                jobId={ocrJobId}
                onOpen={(id) => showView('ocr', id)}
                onSettings={() => navigate('settings')}
                onOpenDocument={(id) => showView('document', id)}
                onStatusChange={setOcrStatus}
              />
            ) : view === 'qc' ? (
              <QcQueue onOpen={(id) => showView('document', id)} />
            ) : view === 'document' && documentBatchId ? (
              <QcWorkspace
                key={documentBatchId}
                batchId={documentBatchId}
                user={user}
                onBack={backFromDocument}
                onCapture={openBatch}
                onDirtyChange={setOcrMetadataDirty}
                onStatusChange={setDocumentStatus}
              />
            ) : view === 'viewer' ? (
              <ViewerWorkspace key={user.id} />
            ) : view === 'viewerRequests' ? (
              <ViewerRegistrations />
            ) : ['documents', 'approvals'].includes(view) ? (
              <Documents
                key={view}
                user={user}
                approvals={view === 'approvals'}
                onOpen={(id) => showView('record', id)}
              />
            ) : view === 'record' && documentBatchId ? (
              <ApprovalDocument
                key={documentBatchId}
                batchId={documentBatchId}
                user={user}
                onBack={backFromRecord}
                onOpenConfirmation={openConfirmation}
                onOpenQc={(id) => showView('document', id)}
              />
            ) : view === 'confirmation' && documentBatchId ? (
              <ApprovalConfirmation
                key={documentBatchId}
                id={documentBatchId}
                onBack={backFromRecord}
                onOpenDocument={(id) => showView('record', id)}
              />
            ) : view === 'settings' ? (
              <OcrSettings user={user} />
            ) : view === 'assignments' ? (
              <BatchList administrative />
            ) : ['users', 'audit', 'system'].includes(view) ? (
              <Administration key={view} view={view} user={user} />
            ) : (
              <div className="empty-workspace">
                <Empty
                  description={
                    <>
                      <h1>Your workspace is not yet available</h1>
                      <p>Your account has no workspace permissions. Contact your administrator.</p>
                    </>
                  }
                />
              </div>
            )}
          </Suspense>
        </div>
      </Layout.Content>
      <footer className={`status-bar${ocrFooter ? ' status-bar-ocr' : ''}`}>
        {view === 'document' && documentStatus?.batchId === documentBatchId ? (
          <div className="document-footer-status" role="status" aria-label={documentStatus.text}>
            <Tag color="blue" icon={<FileTextOutlined aria-hidden />}>
              {documentStatus.included} included pages
            </Tag>
            <Tag color="green" icon={<CheckCircleOutlined aria-hidden />}>
              {documentStatus.reviewed} reviewed
            </Tag>
            <Tag
              color={documentStatus.findings ? 'orange' : 'green'}
              icon={<ExclamationCircleOutlined aria-hidden />}
            >
              {documentStatus.findings} unresolved findings
            </Tag>
            <Tag color="geekblue" icon={<HistoryOutlined aria-hidden />}>
              {documentStatus.unsent ? 'Not sent to QC' : `Cycle ${documentStatus.cycle}`}
            </Tag>
            <Tag color="cyan" icon={<AuditOutlined aria-hidden />}>
              Revision {documentStatus.revision}
            </Tag>
          </div>
        ) : (
          <span title={ocrFooter?.text}>
            {view === 'document'
              ? 'Document review'
              : view === 'ocr' && ocrJobId
                ? ocrFooter?.text || 'OCR job'
                : view === 'viewer'
                  ? 'Published document library · Viewer activity is recorded'
                  : active
                    ? active.batch.batch_code
                    : 'No active batch'}
          </span>
        )}
        {ocrFooter && (
          <Progress
            className="ocr-footer-progress"
            aria-label="OCR job progress"
            percent={ocrFooter.percent}
            size="small"
            status={ocrFooter.status === 'completed_with_errors' ? 'exception' : 'normal'}
          />
        )}
        <span>
          Copyright ©{' '}
          {new Date().getFullYear() === 2025 ? '2025' : `2025–${new Date().getFullYear()}`} - PT.
          Candi Argo Joyo
        </span>
      </footer>
      <ScannerSettings
        open={settings && !locked}
        onClose={() => setSettings(false)}
        scanner={scanner}
        busy={busy}
        scenario={scenario}
        setScenario={setScenario}
        pageDelay={pageDelay}
        setPageDelay={setPageDelay}
        onAction={scannerAction}
      />
      <BatchInfo
        open={info}
        onClose={() => setInfo(false)}
        location={locationDraft}
        onChange={setLocationDraft}
        saving={working === 'location'}
        error={error}
        editable={!active?.operator_locks?.locationLocked}
        onSave={() =>
          run('location', async () => {
            setActive(
              await api(
                `/api/batches/${active.batch.id}`,
                { version: active.batch.version, physicalLocation: locationDraft },
                'PATCH',
              ),
            );
            setInfo(false);
          })
        }
      >
        {active?.pages.length === 0 && (
          <Popconfirm
            title="Cancel this empty batch?"
            description="The batch remains in the audit trail. No files are deleted."
            onConfirm={() =>
              run('cancel', async () => {
                await api(`/api/batches/${active.batch.id}/cancel`, {
                  version: active.batch.version,
                });
                clearBatch();
                showView('home');
              })
            }
          >
            <Button danger disabled={busy}>
              Cancel empty batch
            </Button>
          </Popconfirm>
        )}
      </BatchInfo>
      <Modal
        title="Complete Capture?"
        open={complete}
        onCancel={() => {
          if (!working) setComplete(false);
        }}
        confirmLoading={working === 'complete'}
        okButtonProps={{ disabled: partial && !acknowledge }}
        okText="Complete Capture"
        onOk={() =>
          run('complete', async () => {
            await api(`/api/batches/${active.batch.id}/complete-capture`, {
              version: active.batch.version,
              acknowledgePartial: acknowledge,
            });
            const batchId = active.batch.id;
            clearBatch();
            showView('document', batchId);
          })
        }
      >
        <p>
          {active?.batch.page_count} captured pages in {active?.batch.session_count} sessions.
        </p>
        <p>
          Capture will close and OCR will run. You can then edit metadata or page labels, or skip
          editing and Send to QC. Completing capture does not send it to QC.
        </p>
        {partial && (
          <Checkbox
            checked={acknowledge}
            onChange={(event) => setAcknowledge(event.target.checked)}
          >
            I have reviewed and accept the partial or interrupted sessions and their saved pages.
          </Checkbox>
        )}
      </Modal>
      <Modal
        title={
          stoppingScan || cancellingScan
            ? 'Stopping scan'
            : finalizingScan
              ? 'Saving captured pages'
              : 'Scan in progress'
        }
        open={scanLocked}
        centered
        width={440}
        zIndex={2000}
        closable={false}
        mask={{ closable: false }}
        keyboard={false}
        footer={
          <Button
            danger
            onClick={cancelScan}
            loading={cancellingScan || stoppingScan}
            disabled={finalizingScan || capture?.jobStatus === 'unknown'}
          >
            {stoppingScan || cancellingScan ? 'Cancelling scan…' : 'Cancel scan'}
          </Button>
        }
      >
        <Space size={16} align="start">
          <Spin size="large" />
          <div>
            <p role="status" aria-live="polite" aria-atomic="true">
              {capture
                ? `${capturedPages} ${capturedPages === 1 ? 'page' : 'pages'} captured`
                : 'Preparing scanner…'}
            </p>
            <p>
              {stoppingScan || cancellingScan
                ? 'Waiting for capture to stop and saved pages to finish registering.'
                : finalizingScan
                  ? 'Registering the remaining pages before unlocking the workspace.'
                  : capturedPages
                    ? 'Scanning continues.'
                    : 'Waiting for the first page.'}
            </p>
            <p>
              Captured pages are retained if you cancel. Other actions are locked until capture
              finishes.
            </p>
          </div>
        </Space>
        {(error || capture?.stopError) && (
          <Alert type="error" showIcon title={error || capture.stopError} />
        )}
      </Modal>
    </Layout>
  );
}

const nonce = document.querySelector('meta[name="csp-nonce"]')?.content;
createRoot(document.getElementById('root')).render(
  <ConfigProvider
    theme={enterpriseTheme}
    componentSize="small"
    csp={{ nonce }}
    wave={{ disabled: true }}
  >
    <AntApp
      className="ant-app-root"
      notification={{ placement: 'bottomRight', bottom: 36, stack: { threshold: 2 } }}
    >
      <DigitalArchApp />
    </AntApp>
  </ConfigProvider>,
);
