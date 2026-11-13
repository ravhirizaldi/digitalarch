import sharp from 'sharp';
import { ocrPixels } from './ocr-preprocess.mjs';

export function detectRegions(pixels, width, height) {
  const fallback = (reason) => ({
    regions: [{ x: 0, y: 0, width, height, kind: 'page-fallback' }],
    ignored: [],
    fallback: true,
    reason,
  });
  if (width > height * 1.2) return fallback('landscape');
  const margin = Math.max(2, Math.round(width * 0.025));
  const counts = new Uint32Array(height);
  const columns = new Uint32Array(width);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (pixels[y * width + x] < 180) {
        columns[x]++;
        if (x >= margin && x < width - margin) counts[y]++;
      }
  for (let y = 0; y < height; y++) {
    let ink = 0;
    for (let x = 0; x < width; x++)
      if (
        (x < margin || x >= width - margin) &&
        columns[x] < height * 0.65 &&
        pixels[y * width + x] < 180
      )
        ink++;
    if (ink > Math.max(12, width * 0.008)) return fallback('edge-content');
  }
  let rules = 0,
    inRule = false;
  for (const count of counts) {
    if (count > width * 0.6) {
      if (!inRule) rules++;
      inRule = true;
    } else inRule = false;
  }
  if (rules >= 3) return fallback('ruled-layout');
  let separator = 0;
  for (let y = 0; y < height * 0.18; y++) if (counts[y] > width * 0.6) separator = y;
  const bodyColumns = new Uint32Array(width);
  let totalInk = 0;
  const bodyTop = separator ? separator + 13 : 0;
  for (let y = bodyTop; y < height; y++)
    for (let x = margin; x < width - margin; x++)
      if (pixels[y * width + x] < 180) {
        bodyColumns[x]++;
        totalInk++;
      }
  let gap = 0,
    leftInk = 0;
  for (let x = margin; x < width - margin; x++) {
    leftInk += bodyColumns[x];
    if (
      x > width * 0.3 &&
      x < width * 0.7 &&
      bodyColumns[x] < Math.max(3, (height - bodyTop) * 0.01)
    )
      gap++;
    else gap = 0;
    if (gap > width * 0.045 && leftInk > totalInk * 0.15 && totalInk - leftInk > totalInk * 0.15)
      return fallback('multiple-columns');
  }
  const ignored = [];
  if (separator) {
    const visited = new Uint8Array(width * separator);
    const queue = new Uint32Array(width * separator);
    for (let y = 1; y < separator - 1; y++)
      for (let x = margin; x < width - margin; x++) {
        const index = y * width + x;
        if (visited[index] || pixels[index] >= 180) continue;
        let head = 0,
          tail = 1,
          left = x,
          right = x,
          top = y,
          bottom = y;
        queue[0] = index;
        visited[index] = 1;
        while (head < tail) {
          const at = queue[head++],
            cy = Math.floor(at / width),
            cx = at % width;
          left = Math.min(left, cx);
          right = Math.max(right, cx);
          top = Math.min(top, cy);
          bottom = Math.max(bottom, cy);
          for (const next of [at - 1, at + 1, at - width, at + width]) {
            const ny = Math.floor(next / width),
              nx = next % width;
            if (
              nx < margin ||
              nx >= width - margin ||
              ny < 1 ||
              ny >= separator - 1 ||
              visited[next] ||
              pixels[next] >= 180
            )
              continue;
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
        const w = right - left + 1,
          h = bottom - top + 1;
        if (h > height * 0.016 && w / h > 0.45 && w / h < 1.8 && w < width * 0.15) {
          const extension = Math.max(0, h - w);
          ignored.push({
            x: left - 8 - (left > width / 2 ? extension : 0),
            y: top - 8,
            width: w + 16 + extension,
            height: h + 16,
            reason: 'header-graphic',
          });
        }
      }
  }
  const excluded = (x, y) =>
    ignored.some(
      (box) => x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height,
    );
  const bands = [];
  let start = null,
    last = 0;
  for (let y = 0; y <= height; y++) {
    const active =
      y < height &&
      counts[y] >= Math.max(12, width * 0.012) &&
      counts[y] < width * 0.6 &&
      (!separator || Math.abs(y - separator) > 12);
    if (active) {
      if (start === null) start = y;
      last = y;
    }
    if (start !== null && ((!active && y - last > 2) || y === height)) {
      if (last - start >= 3) bands.push({ top: start, bottom: last });
      start = null;
    }
  }
  const heights = bands.map((b) => b.bottom - b.top + 1).sort((a, b) => a - b);
  const typical = heights[Math.floor(heights.length / 2)] || 12;
  const groups = [];
  for (const band of bands) {
    const previous = groups.at(-1);
    const header = separator > 0 && band.bottom < separator;
    if (previous && previous.header === header && band.top - previous.bottom < typical * 2.7)
      previous.bottom = band.bottom;
    else groups.push({ ...band, header });
  }
  const regions = [];
  for (const group of groups) {
    const columns = new Uint32Array(width);
    for (let y = group.top; y <= group.bottom; y++)
      for (let x = margin; x < width - margin; x++)
        if (pixels[y * width + x] < (group.header ? 215 : 180) && !excluded(x, y)) columns[x]++;
    const spans = [];
    let left = null,
      right = 0;
    for (let x = margin; x <= width - margin; x++) {
      if (columns[x] > 0) {
        if (left === null) left = x;
        right = x;
      }
      if (
        left !== null &&
        (x - right > (group.header ? width * 0.06 : width) || x === width - margin)
      ) {
        spans.push({ left, right });
        left = null;
      }
    }
    for (const span of spans) {
      const pad = Math.max(3, Math.round(typical * 0.35));
      const x = Math.max(margin, span.left - pad),
        y = Math.max(0, group.top - pad);
      regions.push({
        x,
        y,
        width: Math.min(width - margin, span.right + pad + 1) - x,
        height: Math.min(height, group.bottom + pad + 1) - y,
        kind: group.header ? 'header' : 'text',
      });
    }
  }
  // shortcut: horizontal bands target single-column pages; complex columns/tables need an explicit layout editor.
  if (!regions.length || regions.length > 24)
    return fallback(regions.length ? 'too-many-regions' : 'no-text-bands');
  return { regions, ignored, fallback: false };
}

export async function ocrRegions(buffer, signal) {
  const metadata = await sharp(buffer).metadata();
  const preview = await sharp(buffer)
    .resize({ width: 1400, height: 1900, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  const { value, width, height } = await ocrPixels('layout', preview, signal);
  const scaleX = metadata.width / width,
    scaleY = metadata.height / height;
  const scale = (box) => {
    const x = Math.max(0, Math.floor(box.x * scaleX)),
      y = Math.max(0, Math.floor(box.y * scaleY));
    return {
      ...box,
      x,
      y,
      width: Math.min(metadata.width - x, Math.ceil(box.width * scaleX)),
      height: Math.min(metadata.height - y, Math.ceil(box.height * scaleY)),
    };
  };
  return {
    regions: value.regions.map(scale),
    ignored: value.ignored.map(scale),
    fallback: value.fallback,
    reason: value.reason,
    width: metadata.width,
    height: metadata.height,
  };
}
