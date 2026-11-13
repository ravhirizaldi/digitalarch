import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Empty, Modal, Space } from 'antd';
import {
  DownloadOutlined,
  FullscreenOutlined,
  OneToOneOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from '@ant-design/icons';
import { IconButton } from './ui';

export default function PageViewer({
  image,
  rotation = 0,
  label,
  previewUrl,
  originalUrl,
  enlarged = false,
}) {
  const viewport = useRef(null);
  const drag = useRef(null);
  const [bounds, setBounds] = useState({ width: 600, height: 650 });
  const [natural, setNatural] = useState({ width: 850, height: 1100 });
  const [zoom, setZoom] = useState(null);
  const [original, setOriginal] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const observer = new ResizeObserver((entries) =>
      setBounds({ width: entries[0].contentRect.width, height: entries[0].contentRect.height }),
    );
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setZoom(null);
    setOriginal(false);
    setError(false);
  }, [image?.imageId, rotation]);
  const imageWidth = image?.width || natural.width;
  const imageHeight = image?.height || natural.height;
  const sideways = rotation === 90 || rotation === 270;
  const width = sideways ? imageHeight : imageWidth;
  const height = sideways ? imageWidth : imageHeight;
  const fit = Math.min(
    Math.max(40, bounds.width - 32) / width,
    Math.max(40, bounds.height - 32) / height,
    1,
  );
  const scale = zoom ?? fit;
  const originalSource = originalUrl;
  const previewSource = previewUrl;
  const src = (original ? originalSource : previewSource) + `?retry=${retry}`;
  const props = { image, rotation, label, previewUrl, originalUrl };
  return (
    <section className="page-viewer" aria-label={label || 'Document preview'}>
      <div className="preview-toolbar">
        <Space size={4}>
          <IconButton
            label="Zoom out"
            icon={<ZoomOutOutlined />}
            disabled={!image}
            onClick={() => setZoom(Math.max(0.02, scale / 1.25))}
          />
          <span className="zoom-readout">{image ? `${Math.round(scale * 100)}%` : '—'}</span>
          <IconButton
            label="Zoom in"
            icon={<ZoomInOutlined />}
            disabled={!image}
            onClick={() => setZoom(Math.min(8, scale * 1.25))}
          />
          <Button
            disabled={!image}
            onClick={() => {
              setZoom(null);
              setOriginal(false);
              viewport.current.scrollTo(0, 0);
            }}
          >
            Fit page
          </Button>
          <IconButton
            label="Actual size (original)"
            icon={<OneToOneOutlined />}
            disabled={!image}
            onClick={() => {
              setOriginal(true);
              setZoom(1);
            }}
          />
        </Space>
        <Space size={4}>
          {!enlarged && (
            <IconButton
              label="Fullscreen preview"
              icon={<FullscreenOutlined />}
              disabled={!image}
              onClick={() => setFullscreen(true)}
            />
          )}
          <IconButton
            label="Download original PNG"
            icon={<DownloadOutlined />}
            disabled={!image}
            href={originalSource}
            download
          />
        </Space>
      </div>
      {error && (
        <Alert
          type="error"
          showIcon
          title="Image unavailable"
          description="Check scan storage, then retry the preview."
          action={
            <Button
              onClick={() => {
                setError(false);
                setRetry((value) => value + 1);
              }}
            >
              Retry preview
            </Button>
          }
        />
      )}
      <div
        className="image-viewport"
        ref={viewport}
        tabIndex={0}
        aria-label="Scrollable page inspection area"
        onPointerDown={(event) => {
          if (!image || event.button !== 0) return;
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            left: event.currentTarget.scrollLeft,
            top: event.currentTarget.scrollTop,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX;
          event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY;
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        {image ? (
          <div className="image-canvas">
            <div className="image-paper" style={{ width: width * scale, height: height * scale }}>
              <img
                src={src}
                alt={label}
                draggable={false}
                onLoad={(event) => {
                  setError(false);
                  if (!image.width) {
                    const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
                    setNatural((current) =>
                      current.width === width && current.height === height
                        ? current
                        : { width, height },
                    );
                  }
                }}
                onError={() => setError(true)}
                style={{
                  width: imageWidth * scale,
                  height: imageHeight * scale,
                  transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                }}
              />
            </div>
          </div>
        ) : (
          <div className="preview-empty">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="Select a captured page to inspect"
            />
          </div>
        )}
      </div>
      <div className="viewer-info">
        <span>
          {image
            ? `${original ? 'Original pixels' : 'Medium preview'} · ${imageWidth} × ${imageHeight} px · ${rotation}°`
            : 'No page selected'}
        </span>
        <span>Drag to pan</span>
      </div>
      {!enlarged && (
        <Modal
          title={label || 'Document preview'}
          open={fullscreen}
          onCancel={() => setFullscreen(false)}
          footer={null}
          width="calc(100vw - 32px)"
          centered
          destroyOnHidden
          mask={{ closable: false }}
          classNames={{ container: 'preview-modal', body: 'fullscreen-body' }}
        >
          <PageViewer {...props} enlarged />
        </Modal>
      )}
    </section>
  );
}
