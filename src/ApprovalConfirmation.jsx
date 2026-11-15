import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Descriptions, Spin, Tag } from 'antd';
import {
  ArrowLeftOutlined,
  DownloadOutlined,
  PrinterOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { api } from './api';
import { dateTime, IconButton } from './ui';

export default function ApprovalConfirmation({ id, onBack, onOpenDocument }) {
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState('');
  const [qrReady, setQrReady] = useState(false);
  const [qrError, setQrError] = useState(false);
  const [qrRetry, setQrRetry] = useState(0);
  const load = useCallback(
    () =>
      api(`/api/confirmations/${id}`)
        .then(({ confirmation }) => {
          setReceipt(confirmation);
          setError('');
        })
        .catch((error) => setError(error.message)),
    [id],
  );
  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, 10000);
    return () => clearInterval(timer);
  }, [load]);
  return (
    <section className="workspace confirmation-workspace" aria-label="Approval QR receipt">
      <div className="workspace-toolbar no-print">
        <IconButton
          label="Back to documents"
          icon={<ArrowLeftOutlined aria-hidden />}
          onClick={onBack}
        />
        <h1>Confirmation QR</h1>
        <span className="toolbar-spacer" />
        <IconButton
          label="Refresh confirmation"
          icon={<ReloadOutlined aria-hidden />}
          onClick={load}
        />
        {receipt && (
          <>
            <Button onClick={() => onOpenDocument(receipt.batch_id)}>View document</Button>
            <Button
              icon={<DownloadOutlined aria-hidden />}
              href={`/api/confirmations/${id}/qr`}
              download={`DigitalArch-${receipt.batch_code}-L${receipt.level}.png`}
              disabled={!qrReady || !!error}
            >
              Download QR
            </Button>
            <Button
              type="primary"
              icon={<PrinterOutlined aria-hidden />}
              disabled={!qrReady || !!error}
              onClick={() => window.print()}
            >
              Print QR
            </Button>
          </>
        )}
      </div>
      {error && <Alert type="error" title={error} action={<Button onClick={load}>Retry</Button>} />}
      {!receipt && !error && <Spin />}
      {receipt && (
        <article className="confirmation-receipt">
          <h2>{receipt.batch_code}</h2>
          <p>
            L{receipt.level} confirmation ·{' '}
            {receipt.final
              ? 'Final publication confirmation'
              : receipt.published
                ? 'L1 confirmed · L2 subsequently confirmed'
                : 'L1 confirmation · L2 required for publication'}
          </p>
          <Tag color={receipt.current ? (receipt.published ? 'success' : 'processing') : 'warning'}>
            {receipt.current
              ? receipt.published
                ? 'Currently published'
                : 'Awaiting L2 confirmation'
              : 'Historical confirmation · not current approval'}
          </Tag>
          <img
            className="confirmation-qr"
            src={`/api/confirmations/${id}/qr?retry=${qrRetry}`}
            onLoad={() => {
              setQrReady(true);
              setQrError(false);
            }}
            onError={() => {
              setQrReady(false);
              setQrError(true);
            }}
            alt={`Verification QR for ${receipt.batch_code}, L${receipt.level} confirmation`}
          />
          {qrError && (
            <Alert
              className="no-print"
              type="error"
              title="QR unavailable"
              description="Retry before printing this receipt."
              action={
                <Button
                  onClick={() => {
                    setQrReady(false);
                    setQrError(false);
                    setQrRetry((value) => value + 1);
                  }}
                >
                  Retry QR
                </Button>
              }
            />
          )}
          <Descriptions
            bordered
            column={1}
            items={[
              { key: 'officer', label: 'Confirmed by', children: receipt.officer },
              { key: 'date', label: 'Confirmed · WIB', children: dateTime(receipt.decided_at) },
              { key: 'revision', label: 'QC revision', children: receipt.reviewed_revision },
              { key: 'cycle', label: 'QC cycle', children: receipt.cycle },
              { key: 'id', label: 'Confirmation ID', children: receipt.id },
            ]}
          />
          <p className="confirmation-note">
            Scan to verify this recorded decision in DigitalArch. Sign-in and document access are
            required. This QR is not an approval credential; a printed receipt does not prove the
            document is still published.
          </p>
          <p className="confirmation-note">
            Verification opens the local DigitalArch application on the workstation that issued this
            receipt.
          </p>
        </article>
      )}
    </section>
  );
}
