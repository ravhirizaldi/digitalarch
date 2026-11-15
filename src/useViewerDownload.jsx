import React, { useEffect, useRef, useState } from 'react';
import { App, Button, Progress, Space } from 'antd';
import { api, apiRequest } from './api';
import { receivePdf, stagePdf } from './downloadPdf';

const byteSize = (value) =>
  value >= 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(value / 1024)} KB`;
const noticeKey = 'viewer-pdf-download';

export default function useViewerDownload() {
  const { notification } = App.useApp();
  const [state, setState] = useState(null);
  const [hidden, setHidden] = useState(false);
  const current = useRef(null);
  const ready = useRef(null);
  const expiry = useRef(null);
  const saving = useRef(false);
  const mounted = useRef(true);
  const busy = !!state && ['preparing', 'downloading', 'saving'].includes(state.status);
  const update = (patch) => {
    if (mounted.current) setState((old) => ({ ...old, ...patch }));
  };
  useEffect(() => {
    mounted.current = true;
    const active = current,
      retained = ready,
      timer = expiry;
    return () => {
      mounted.current = false;
      active.current?.abort();
      clearTimeout(timer.current);
      retained.current?.dispose().catch(() => {});
      notification.destroy(noticeKey);
    };
  }, [notification]);

  async function report(job, outcome, stats, saveMode = 'browser') {
    try {
      await api(`/api/viewer/downloads/${job.id}/report`, {
        outcome,
        saveMode,
        bytes: stats.bytes,
        durationMs: stats.durationMs,
      });
    } catch (error) {
      update({ warning: `Transfer reporting failed: ${error.message}` });
    }
  }
  async function save(automatic = false) {
    const item = ready.current;
    if (!item || saving.current) return;
    saving.current = true;
    const controller = current.current || new AbortController();
    current.current = controller;
    let writer;
    update({ status: 'saving' });
    try {
      controller.signal.throwIfAborted();
      if (window.showSaveFilePicker) {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: item.filename,
            types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }],
          });
          controller.signal.throwIfAborted();
          writer = await handle.createWritable();
        } catch (error) {
          if (!automatic || !['SecurityError', 'NotAllowedError'].includes(error.name)) throw error;
        }
      }
      controller.signal.throwIfAborted();
      if (writer) {
        await item.blob.stream().pipeTo(writer, { signal: controller.signal });
        update({ status: 'saved' });
        await report(item.job, 'saved', item.stats, 'file');
      } else {
        const link = document.createElement('a');
        link.href = item.url;
        link.download = item.filename;
        link.click();
        update({ status: 'received' });
      }
    } catch (error) {
      await writer?.abort().catch(() => {});
      update({
        status: 'received',
        ...(error.name === 'AbortError' ? {} : { warning: `Save failed: ${error.message}` }),
      });
    } finally {
      saving.current = false;
      if (current.current === controller) current.current = null;
    }
  }
  useEffect(() => {
    if (!state || hidden) return;
    const speed = state.durationMs > 0 ? state.bytes / (state.durationMs / 1000) : 0;
    const remaining =
      speed && state.total ? Math.max(0, Math.ceil((state.total - state.bytes) / speed)) : null;
    const percent =
      state.status === 'preparing'
        ? 0
        : ['received', 'saved', 'saving'].includes(state.status)
          ? 100
          : state.total
            ? Math.min(99, Math.floor((state.bytes / state.total) * 100))
            : 0;
    notification.open({
      key: noticeKey,
      duration: 0,
      placement: 'bottomRight',
      title:
        state.status === 'preparing'
          ? 'Preparing PDF'
          : state.status === 'downloading'
            ? 'Downloading PDF'
            : state.status === 'saving'
              ? 'Save PDF'
              : state.status === 'saved'
                ? 'PDF saved'
                : state.status === 'received'
                  ? 'PDF ready to save'
                  : state.status === 'cancelled'
                    ? 'Download cancelled'
                    : 'Download failed',
      description: (
        <div className="viewer-transfer-notice" role="status">
          <strong>{state.title}</strong>
          <Progress
            aria-label="PDF download progress"
            percent={percent}
            size="small"
            status={state.status === 'failed' ? 'exception' : undefined}
          />
          {state.status === 'preparing' ? (
            <span>
              {state.processed || 0}/{state.pages} pages prepared. Transfer starts automatically.
            </span>
          ) : state.status === 'downloading' ? (
            <span>
              {byteSize(state.bytes)} / {byteSize(state.total)} · {byteSize(speed)}/s ·{' '}
              {Math.floor(state.durationMs / 1000)}s elapsed
              {remaining === null ? '' : ` · ~${remaining}s remaining`}
            </span>
          ) : state.status === 'received' ? (
            <span>Finish saving in your browser. If no dialog opened, choose Save PDF.</span>
          ) : state.status === 'saved' ? (
            <span>Saved in {(state.durationMs / 1000).toFixed(1)}s.</span>
          ) : state.status === 'saving' ? (
            <span>100% received. Choose where to save your PDF.</span>
          ) : (
            <span>{state.error || 'The incomplete transfer was discarded.'}</span>
          )}
          {state.warning && <span className="viewer-transfer-warning">{state.warning}</span>}
          {state.expired && <span>Temporary download expired. Download the document again.</span>}
          <Space>
            {['preparing', 'downloading', 'saving'].includes(state.status) && (
              <Button onClick={() => current.current?.abort()}>
                {state.status === 'saving' ? 'Cancel save' : 'Cancel download'}
              </Button>
            )}
            {['received', 'saved'].includes(state.status) && !state.expired && (
              <Button type="primary" onClick={() => save()}>
                Save PDF
              </Button>
            )}
          </Space>
          {busy && <span className="muted">Dismiss to hide progress; the download continues.</span>}
        </div>
      ),
      onClose: () => setHidden(true),
    });
  });
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      setState((old) =>
        old && old.status === 'downloading'
          ? { ...old, durationMs: Math.round(performance.now() - old.started) }
          : old,
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [busy]);

  async function transfer(job, controller, filename) {
    let staging;
    let started = 0;
    let stats = { bytes: 0, total: 0, durationMs: 0 };
    try {
      while (job.status === 'preparing') {
        controller.signal.throwIfAborted();
        job = await api(`/api/viewer/downloads/${job.id}`);
        update({ processed: job.processed });
        if (job.status === 'preparing') await new Promise((resolve) => setTimeout(resolve, 750));
      }
      controller.signal.throwIfAborted();
      if (job.status !== 'ready')
        throw new Error(job.error || 'PDF preparation failed. Try again.');
      staging = await stagePdf();
      controller.signal.throwIfAborted();
      started = performance.now();
      update({ status: 'downloading', started });
      const response = await apiRequest(
        `/api/viewer/downloads/${job.id}/transfer`,
        {},
        'POST',
        controller.signal,
      );
      let last = 0;
      const result = await receivePdf(response, {
        writer: staging.writer,
        onProgress: (next) => {
          stats = { ...next, durationMs: Math.round(performance.now() - started) };
          if (performance.now() - last > 150 || next.bytes === next.total) {
            update(stats);
            last = performance.now();
          }
        },
      });
      controller.signal.throwIfAborted();
      const blob = result.blob || (await staging.file());
      controller.signal.throwIfAborted();
      stats.durationMs = Math.round(performance.now() - started);
      const url = URL.createObjectURL(blob);
      const item = {
        blob,
        url,
        filename,
        job,
        stats,
        dispose: async () => {
          URL.revokeObjectURL(url);
          await staging.dispose();
        },
      };
      ready.current = item;
      const expire = () => {
        if (ready.current !== item) return;
        if (saving.current) {
          expiry.current = setTimeout(expire, 60_000);
          return;
        }
        ready.current = null;
        item.dispose().catch(() => {});
        update({ expired: true });
      };
      expiry.current = setTimeout(expire, 10 * 60_000);
      update({ ...stats, status: 'saving' });
      await report(job, 'received', stats);
      if (mounted.current) await save(true);
    } catch (error) {
      if (started) stats.durationMs = Math.round(performance.now() - started);
      await staging?.writer?.abort().catch(() => {});
      await staging?.dispose().catch(() => {});
      const outcome = error.name === 'AbortError' ? 'cancelled' : 'failed';
      update({ ...stats, status: outcome, error: error.message });
      await report(job, outcome, stats);
    } finally {
      if (current.current === controller) current.current = null;
    }
  }
  async function start(batchId, body, title) {
    if (current.current || saving.current)
      throw new Error('Another PDF is downloading or saving. Wait or cancel it first.');
    const controller = new AbortController();
    current.current = controller;
    clearTimeout(expiry.current);
    await ready.current?.dispose().catch(() => {});
    ready.current = null;
    setHidden(false);
    setState({
      status: 'preparing',
      title,
      pages: 0,
      processed: 0,
      bytes: 0,
      total: 0,
      durationMs: 0,
    });
    try {
      const job = await api(`/api/viewer/documents/${batchId}/downloads`, body);
      update({ pages: job.total });
      void transfer(job, controller, `document-${batchId.slice(0, 8)}.pdf`);
    } catch (error) {
      current.current = null;
      update({ status: 'failed', error: error.message });
      throw error;
    }
  }
  return { start, busy, hasDownload: !!state, show: () => setHidden(false) };
}
