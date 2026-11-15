import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Drawer, Empty, Segmented, Space, Spin, Tag } from 'antd';
import {
  BellOutlined,
  CheckOutlined,
  EyeOutlined,
  MailOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { api } from './api';
import { dateTime, IconButton } from './ui';
import './notifications.css';

export default function StaffNotifications({ user, onOpen, disabled }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('unread');
  const [cursors, setCursors] = useState([null]);
  const [data, setData] = useState({ unread: 0, latest: '0', notifications: [], next: null });
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const request = useRef({ version: 0 });
  const list = useRef(null);
  const before = cursors.at(-1);
  useEffect(() => {
    if (open) list.current?.focus({ preventScroll: true });
  }, [selected?.id, open]);
  const refresh = useCallback(async () => {
    const version = ++request.current.version;
    setLoading(true);
    try {
      const result = await api(
        open
          ? `/api/notifications?filter=${filter}${before ? `&before=${before}` : ''}`
          : '/api/notifications/summary',
      );
      if (version !== request.current.version) return;
      setData((old) => ({ ...old, ...result }));
      setError('');
    } catch (error) {
      if (version === request.current.version) setError(error.message);
    } finally {
      if (version === request.current.version) setLoading(false);
    }
  }, [open, filter, before]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    const current = request.current;
    refresh();
    return () => {
      current.version++;
    };
  }, [refresh]);
  useEffect(() => {
    let timer;
    let closed = false;
    const stream = new EventSource('/api/notifications/stream');
    const invalidate = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!closed) refreshRef.current();
      }, 250);
    };
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    stream.addEventListener('inbox', invalidate);
    window.addEventListener('focus', invalidate);
    return () => {
      closed = true;
      clearTimeout(timer);
      stream.close();
      window.removeEventListener('focus', invalidate);
    };
  }, [user.id]);
  async function change(item, action, navigate = false) {
    if (working) return;
    setWorking(true);
    setError('');
    try {
      if (navigate && !(await onOpen(item.destination))) return;
      const result = await api(`/api/notifications/${item.id}`, { action });
      if (!navigate && action === 'view') setSelected({ ...item, ...result.state });
      if (navigate) setOpen(false);
      await refresh();
    } catch (error) {
      setError(error.message);
    } finally {
      setWorking(false);
    }
  }
  async function readAll() {
    setWorking(true);
    try {
      await api('/api/notifications', { action: 'read-all', through: data.latest });
      setCursors([null]);
      await refresh();
    } catch (error) {
      setError(error.message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <>
      <Badge count={data.unread} overflowCount={99} size="small">
        <IconButton
          type="text"
          className="header-account-button"
          label={`Notifications, ${data.unread} unread`}
          icon={<BellOutlined aria-hidden />}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            setCursors([null]);
            setSelected(null);
            setOpen(true);
          }}
        />
      </Badge>
      <Drawer
        title="Notifications"
        size={600}
        open={open}
        onClose={() => setOpen(false)}
        className="staff-notifications"
        extra={
          <IconButton
            label="Refresh notifications"
            icon={<ReloadOutlined aria-hidden />}
            onClick={refresh}
            loading={loading}
          />
        }
      >
        {!selected && (
          <div className="staff-inbox-toolbar">
            <Segmented
              aria-label="Notification filter"
              value={filter}
              options={[
                { label: `Unread (${data.unread})`, value: 'unread' },
                { label: 'All', value: 'all' },
              ]}
              onChange={(value) => {
                setFilter(value);
                setCursors([null]);
                setSelected(null);
              }}
            />
            <Button
              icon={<CheckOutlined aria-hidden />}
              disabled={!data.unread || working || loading}
              onClick={readAll}
            >
              Mark all read
            </Button>
          </div>
        )}
        {!connected && (
          <p className="staff-inbox-connection" role="status">
            Live updates reconnecting. You can refresh manually.
          </p>
        )}
        {error && (
          <Alert type="error" title={error} action={<Button onClick={refresh}>Retry</Button>} />
        )}
        <div
          className="staff-inbox-list"
          aria-busy={loading}
          tabIndex={-1}
          ref={list}
          role="region"
          aria-label={selected ? 'Notification details' : 'Notification history'}
        >
          {selected ? (
            <article className="staff-inbox-item">
              <Button onClick={() => setSelected(null)}>Back to notifications</Button>
              <h2 className="staff-inbox-title">{selected.label}</h2>
              <p className="staff-inbox-title">{selected.title}</p>
              <p className="staff-inbox-context">
                {selected.batch_code} · {selected.actor} · {dateTime(selected.created_at)} WIB
              </p>
              <div className="staff-inbox-detail">
                <p>{selected.reason || 'No additional reason recorded.'}</p>
              </div>
              <p className="staff-inbox-context">Viewed: {dateTime(selected.viewed_at)} WIB</p>
              {selected.destination && (
                <Button
                  icon={<EyeOutlined aria-hidden />}
                  disabled={disabled || working}
                  onClick={() => change(selected, 'view', true)}
                >
                  {selected.destination.label}
                </Button>
              )}
            </article>
          ) : loading && !data.notifications.length ? (
            <Spin />
          ) : !data.notifications.length ? (
            <Empty
              description={
                filter === 'unread'
                  ? 'No unread notifications. All keeps your history.'
                  : 'No notifications yet.'
              }
            />
          ) : (
            data.notifications.map((item) => (
              <article
                key={item.id}
                className={`staff-inbox-item${!item.read_at ? ' staff-inbox-unread' : ''}`}
              >
                <div className="staff-inbox-heading">
                  <Button type="link" onClick={() => change(item, 'view')} disabled={working}>
                    {item.label}
                  </Button>
                  <Tag color={!item.read_at ? 'blue' : undefined}>
                    {item.read_at ? 'Read' : 'Unread'}
                  </Tag>
                </div>
                <p className="staff-inbox-title">{item.title}</p>
                <p className="staff-inbox-context">
                  {item.batch_code} · {item.actor} · {dateTime(item.created_at)} WIB
                </p>
                <p className="staff-inbox-stage">Current: {item.stage?.replaceAll('_', ' ')}</p>
                <Space wrap>
                  {item.destination && (
                    <Button
                      icon={<EyeOutlined aria-hidden />}
                      disabled={disabled || working}
                      onClick={() => change(item, 'view', true)}
                    >
                      {item.destination.label}
                    </Button>
                  )}
                  <Button
                    type="text"
                    icon={
                      item.read_at ? <MailOutlined aria-hidden /> : <CheckOutlined aria-hidden />
                    }
                    disabled={working}
                    onClick={() => change(item, item.read_at ? 'unread' : 'read')}
                  >
                    {item.read_at ? 'Mark unread' : 'Mark read'}
                  </Button>
                </Space>
              </article>
            ))
          )}
        </div>
        <div className="staff-inbox-footer">
          <span>Read does not mean completed.</span>
          {!selected && (
            <Space>
              <Button
                disabled={cursors.length === 1 || loading || working}
                onClick={() => setCursors((old) => old.slice(0, -1))}
              >
                Newer
              </Button>
              <Button
                disabled={!data.next || loading || working}
                onClick={() => setCursors((old) => [...old, data.next])}
              >
                Older
              </Button>
            </Space>
          )}
        </div>
      </Drawer>
    </>
  );
}
