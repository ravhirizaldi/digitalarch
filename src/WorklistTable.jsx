import React, { useEffect, useRef, useState } from 'react';
import { Pagination, Table, Tooltip, Typography } from 'antd';
import { CheckOutlined, InfoCircleOutlined } from '@ant-design/icons';

export function useTableHeight(reservedHeight = 110) {
  const region = useRef(null);
  const [height, setHeight] = useState(250);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setHeight(Math.max(80, entry.contentRect.height - reservedHeight)),
    );
    if (region.current) observer.observe(region.current);
    return () => observer.disconnect();
  }, [reservedHeight]);
  return [region, height];
}

export function ColumnHeading({ icon, children }) {
  return (
    <span className="worklist-column-heading">
      {icon}
      {children}
    </span>
  );
}

export function BatchIdHeading() {
  return (
    <Tooltip title="Batch ID · hover to view, click to copy">
      <InfoCircleOutlined aria-label="Batch ID" />
    </Tooltip>
  );
}

export function BatchIdentity({ value, children }) {
  return (
    <Typography.Text
      className="worklist-batch-id"
      copyable={{
        text: value,
        icon: [
          <InfoCircleOutlined key="copy" aria-hidden />,
          <CheckOutlined key="copied" aria-hidden />,
        ],
        tooltips: [`${value} · Click to copy batch ID`, 'Batch ID copied'],
      }}
    >
      {children}
    </Typography.Text>
  );
}

export default function WorklistTable({ totals, pagination, scroll, ...props }) {
  const [region, height] = useTableHeight(50);
  return (
    <>
      <div
        className="registry-table-region worklist-table"
        ref={region}
        style={{ '--worklist-body-height': `${height}px` }}
      >
        <Table
          size="small"
          rowKey="id"
          {...props}
          pagination={false}
          scroll={{ ...scroll, y: height }}
        />
      </div>
      <div className="worklist-footer">
        <div className="worklist-totals" role="status" aria-label="Filtered table totals">
          {totals.map(({ label, value, icon }) => (
            <span key={label}>
              {icon}
              <strong>{value ?? '—'}</strong>
              {label}
            </span>
          ))}
        </div>
        <Pagination size="small" showSizeChanger pageSizeOptions={[25, 50, 100]} {...pagination} />
      </div>
    </>
  );
}
