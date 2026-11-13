import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Checkbox,
  ConfigProvider,
  Drawer,
  Empty,
  Input,
  Layout,
  Menu,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Tag,
} from 'antd';
import {
  DatabaseOutlined,
  FileTextOutlined,
  LogoutOutlined,
  ScanOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { enterpriseTheme } from './theme';
import { api, setCsrfToken } from './api';
import { matchRoute, permittedRoute, routePath } from './routes';
import { statusLabels } from './ui';
import ScannerSettings from './ScannerSettings';
import ScannerWorkspace from './ScannerWorkspace';
import AuthScreen from './AuthScreen';
import BatchList from './BatchList';
import './style.css';

const Administration = lazy(() => import('./Administration'));
const OcrWorkspace = lazy(() => import('./OcrWorkspace'));
const OcrSettings = lazy(() => import('./OcrSettings'));

function DigitalArchApp() {
  const [identity, setIdentity] = useState(null);
  const [initializing, setInitializing] = useState(true);
  const [view, setView] = useState('home');
  const [scanner, setScanner] = useState({});
  const [active, setActive] = useState(null);
  const [ocrJobId, setOcrJobId] = useState(null);
  const activeId = useRef(null);
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
  const user = identity?.user;
  const can = useCallback((permission) => !!user?.permissions.includes(permission), [user]);
  const operational = can('batches:create');
  const scanning = active?.sessions.some((session) => session.status === 'running');
  const locked = active && !['in_progress', 'paused'].includes(active.batch.status);
  const busy = !!working || scanning || scanner.busy || scanner.checking;
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
    const pathname = routePath(next, batchId);
    if (window.location.pathname !== pathname)
      window.history[replace ? 'replaceState' : 'pushState'](null, '', pathname);
    setView(next);
  }, []);
  const restoreRoute = useCallback(
    async (account, requested = matchRoute(window.location.pathname)) => {
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
          showView('scanner', result.batch.id, true);
        } else {
          clearBatch();
          showView(route.view, route.jobId || null, true);
        }
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
  const hasActive = !!active;
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
    if (!user || user.must_change_password) return;
    const pop = async () => {
      const currentPath = routePath(view, view === 'ocr' ? ocrJobId : active?.batch.id);
      if (busy || navigatingHistory.current) {
        window.history.pushState(null, '', currentPath);
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
      } finally {
        navigatingHistory.current = false;
      }
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [user, busy, active, locked, view, ocrJobId, restoreRoute]);

  async function run(label, operation) {
    if (working) return;
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
    await run('create', async () => {
      const result = await api('/api/batches', {});
      activeId.current = result.batch.id;
      setActive(result);
      showView('scanner', result.batch.id);
    });
  }
  async function openBatch(batch) {
    await run('resume', async () => {
      const result =
        batch.status === 'capture_completed'
          ? await api(`/api/batches/${batch.id}`)
          : await api(`/api/batches/${batch.id}/resume`, { version: batch.version });
      clearBatch();
      activeId.current = result.batch.id;
      setActive(result);
      showView('scanner', result.batch.id);
    });
  }
  async function leave(next = 'home') {
    await run('pause', async () => {
      if (active && !locked)
        await api(`/api/batches/${active.batch.id}/pause`, { version: active.batch.version });
      clearBatch();
      showView(next);
    });
  }
  function navigate(next) {
    if (busy) return;
    if (active && next !== 'scanner') leave(next);
    else {
      setError('');
      showView(next, next === 'scanner' ? active?.batch.id : null);
    }
  }
  async function scannerAction(route, body = {}) {
    if (route === 'mode') setRequestedMode(body.mode);
    await run(route, async () => {
      if (route === 'scan') {
        const result = await api(`/api/batches/${active.batch.id}/scan-sessions`, {
          version: active.batch.version,
          options: body,
        });
        if (activeId.current === result.batch.id) setActive(result);
      } else setScanner(await api(`/api/scanner/${route}`, body));
      await refresh();
    });
    setRequestedMode(null);
  }
  const changePage = (page, action) =>
    run('page', async () => {
      const result = await api(
        `/api/pages/${page.id}`,
        { version: active.batch.version, action },
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
      pageNumber: page.display_order,
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
    ...(can('ocr:read')
      ? [{ key: 'ocr', label: 'OCR Processing', icon: <FileTextOutlined aria-hidden /> }]
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
  if (user.must_change_password || changingPassword)
    return <AuthScreen user={user} onAuthenticated={authenticated} />;
  return (
    <Layout className="app-shell">
      <Layout.Header className="app-header">
        <span className="brand">
          <ScanOutlined /> DigitalArch
        </span>
        <span className="header-module">
          {can('users:read') && !operational ? 'Administration' : 'Document capture'}
        </span>
        <div className="header-operational">
          {can('scanner:read') && (
            <Badge
              status={scanner.canScan ? 'success' : 'warning'}
              text={
                <span className="header-status">
                  {scanner.busy ? 'Scanning' : statusLabels[scanner.state] || 'Checking scanner'}
                </span>
              }
            />
          )}
          <span>{user.display_name}</span>
          <Button disabled={busy || !!active} onClick={() => setChangingPassword(true)}>
            Change password
          </Button>
          <Button
            icon={<LogoutOutlined aria-hidden />}
            disabled={busy}
            onClick={() =>
              run('logout', async () => {
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
      </Layout.Header>
      {!!items.length && (
        <nav className="workspace-nav" aria-label="Workspace">
          <Menu
            mode="horizontal"
            disabled={busy}
            selectedKeys={[view]}
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
                creating={!!working}
                userId={user.id}
              />
            ) : view === 'scanner' ? (
              !active ? (
                <div className="empty-workspace">
                  <Empty
                    description={
                      <>
                        <h1>No active batch</h1>
                        <p>Create a new batch or select an existing one.</p>
                      </>
                    }
                  >
                    <Space>
                      <Button type="primary" loading={!!working} onClick={newBatch}>
                        Scan New Batch
                      </Button>
                      <Button onClick={() => showView('batches')}>Open My Batches</Button>
                    </Space>
                  </Empty>
                </div>
              ) : (
                <>
                  <div className="workspace-toolbar batch-context">
                    <div>
                      <h1>
                        Active batch · {active.batch.batch_code}
                        {latest ? ` (Session ${latest.session_number})` : ''}
                      </h1>
                      {active.batch.physical_location && (
                        <span className="muted">{active.batch.physical_location}</span>
                      )}
                    </div>
                    <span className="toolbar-spacer" />
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
                    scenario={scenario}
                    setScenario={setScenario}
                    pageDelay={pageDelay}
                    onAction={scannerAction}
                    onSettings={() => setSettings(true)}
                    onPageAction={changePage}
                    sessions={active.sessions}
                    locked={locked}
                  />
                </>
              )
            ) : view === 'ocr' ? (
              <OcrWorkspace
                user={user}
                jobId={ocrJobId}
                onOpen={(id) => showView('ocr', id)}
                onSettings={() => navigate('settings')}
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
                      <p>
                        Your account is ready. QC, approval and published archive workflows will be
                        introduced in a later phase.
                      </p>
                    </>
                  }
                />
              </div>
            )}
          </Suspense>
        </div>
      </Layout.Content>
      <footer className="status-bar">
        <span>{active ? active.batch.batch_code : 'No active batch'}</span>
        <span>Asia/Jakarta · WIB</span>
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
      <Drawer title="Batch Info" open={info} onClose={() => setInfo(false)} size={360}>
        <Space orientation="vertical">
          <p>Physical location is optional and may be shared by multiple batches.</p>
          <label htmlFor="physical-location">Physical location</label>
          <Input
            id="physical-location"
            value={locationDraft}
            maxLength={240}
            placeholder="Rack A-12, Box 017…"
            onChange={(event) => setLocationDraft(event.target.value)}
          />
          <Button
            type="primary"
            loading={working === 'location'}
            onClick={() =>
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
            Save location
          </Button>
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
        </Space>
      </Drawer>
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
            clearBatch();
            showView('home');
          })
        }
      >
        <p>
          {active?.batch.page_count} captured pages in {active?.batch.session_count} sessions.
        </p>
        <p>This locks capture for this batch. It does not complete QC or send it for approval.</p>
        {partial && (
          <Checkbox
            checked={acknowledge}
            onChange={(event) => setAcknowledge(event.target.checked)}
          >
            I have reviewed and accept the partial or interrupted sessions and their saved pages.
          </Checkbox>
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
    <AntApp className="ant-app-root">
      <DigitalArchApp />
    </AntApp>
  </ConfigProvider>,
);
