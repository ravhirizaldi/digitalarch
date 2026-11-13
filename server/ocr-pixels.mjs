import { parentPort, workerData } from 'node:worker_threads';
import { detectRegions } from './ocr-layout.mjs';

export function estimateSkew(pixels, width, height) {
  const points = [];
  for (let y = 0; y < height; y += 2)
    for (let x = 0; x < width; x += 2) if (pixels[y * width + x] < 150) points.push(x, y);
  function score(angle) {
    const rows = new Uint32Array(height + 128);
    const slope = Math.tan((angle * Math.PI) / 180);
    for (let i = 0; i < points.length; i += 2) {
      const row = Math.round(points[i + 1] + slope * (points[i] - width / 2)) + 64;
      if (row >= 0 && row < rows.length) rows[row]++;
    }
    let value = 0;
    for (const count of rows) value += count * count;
    return value;
  }
  const baseline = score(0);
  let best = baseline,
    angle = 0;
  for (let value = -3; value <= 3; value += 0.5) {
    const candidate = score(value);
    if (candidate > best) {
      best = candidate;
      angle = value;
    }
  }
  const coarse = angle;
  for (let value = coarse - 0.4; value <= coarse + 0.4; value += 0.1) {
    if (Math.abs(value) > 3) continue;
    const candidate = score(value);
    if (candidate > best) {
      best = candidate;
      angle = value;
    }
  }
  return baseline && best / baseline >= 1.05 && Math.abs(angle) >= 0.15
    ? Math.round(angle * 10) / 10
    : 0;
}

export function adaptiveThreshold(pixels, width, height, radius = 15) {
  const output = new Uint8Array(pixels.length);
  const columns = new Float64Array(width);
  for (let y = 0; y < Math.min(height, radius + 1); y++)
    for (let x = 0; x < width; x++) columns[x] += pixels[y * width + x];
  for (let y = 0; y < height; y++) {
    if (y > 0)
      for (let x = 0; x < width; x++) {
        if (y + radius < height) columns[x] += pixels[(y + radius) * width + x];
        if (y - radius - 1 >= 0) columns[x] -= pixels[(y - radius - 1) * width + x];
      }
    const rows = Math.min(height - 1, y + radius) - Math.max(0, y - radius) + 1;
    let sum = 0;
    for (let x = 0; x < Math.min(width, radius + 1); x++) sum += columns[x];
    for (let x = 0; x < width; x++) {
      if (x > 0) {
        if (x + radius < width) sum += columns[x + radius];
        if (x - radius - 1 >= 0) sum -= columns[x - radius - 1];
      }
      const count = rows * (Math.min(width - 1, x + radius) - Math.max(0, x - radius) + 1);
      output[y * width + x] = pixels[y * width + x] < (sum / count) * 0.88 ? 0 : 255;
    }
  }
  return output;
}

export function removePenLines(pixels, width, height) {
  const step = Math.max(1, Math.round(width / 1200));
  const points = [];
  for (let y = 0; y < height; y += step * 2) {
    let ink = 0;
    const row = [];
    for (let x = Math.round(width * 0.02); x < width * 0.98; x++)
      if (pixels[y * width + x] < 140) {
        ink++;
        row.push(x);
      }
    if (ink < width * 0.014) for (const x of row) points.push(x, y);
  }
  const bin = step * 3,
    offset = height * 2;
  const candidates = [];
  for (let angle = -50; angle <= 50; angle += 0.5) {
    if (Math.abs(angle) < 12) continue;
    const slope = Math.tan((angle * Math.PI) / 180),
      counts = new Uint32Array(Math.ceil((width + height * 4) / bin));
    for (let i = 0; i < points.length; i += 2) {
      const b = Math.floor((points[i] - slope * points[i + 1] + offset) / bin);
      if (b >= 0 && b < counts.length) counts[b]++;
    }
    let maximum = 0,
      at = 0;
    for (let i = 0; i < counts.length; i++)
      if (counts[i] > maximum) {
        maximum = counts[i];
        at = i;
      }
    if (maximum < height / (step * 16)) continue;
    const intercept = (at + 0.5) * bin - offset;
    let top = height,
      bottom = 0;
    const rows = new Set();
    for (let i = 0; i < points.length; i += 2)
      if (Math.abs(points[i] - slope * points[i + 1] - intercept) < bin / 2) {
        rows.add(points[i + 1]);
        top = Math.min(top, points[i + 1]);
        bottom = Math.max(bottom, points[i + 1]);
      }
    if (bottom - top > height * 0.22 && rows.size > (bottom - top) / (step * 7))
      candidates.push({ slope, intercept, top, bottom, support: rows.size });
  }
  candidates.sort((a, b) => b.support - a.support);
  const lines = [];
  for (const line of candidates) {
    if (
      lines.some(
        (other) =>
          Math.abs(other.slope - line.slope) < 0.1 &&
          Math.abs(
            ((other.slope - line.slope) * (line.top + line.bottom)) / 2 +
              other.intercept -
              line.intercept,
          ) <
            step * 8,
      )
    )
      continue;
    lines.push(line);
    if (lines.length === 4) break;
  }
  const output = new Uint8Array(pixels);
  let removedPixels = 0;
  for (const line of lines)
    for (let y = line.top; y <= line.bottom; y++) {
      const center = Math.round(line.slope * y + line.intercept),
        radius = step * 4;
      for (let x = Math.max(1, center - radius); x < Math.min(width - 1, center + radius); x++) {
        if (pixels[y * width + x] >= 170) continue;
        let left = x,
          right = x;
        while (left > 0 && pixels[y * width + left - 1] < 170) left--;
        while (right < width - 1 && pixels[y * width + right + 1] < 170) right++;
        // Preserve thick glyph intersections; never reconstruct obscured letters or digits.
        if (right - left + 1 <= step * 3)
          for (let at = left; at <= right; at++)
            if (output[y * width + at] !== 255) {
              output[y * width + at] = 255;
              removedPixels++;
            }
        x = right;
      }
    }
  return { pixels: output, removedPixels, lines };
}

if (parentPort) {
  const { pixels, width, height, operation } = workerData;
  const value =
    operation === 'deskew'
      ? estimateSkew(pixels, width, height)
      : operation === 'layout'
        ? detectRegions(pixels, width, height)
        : operation === 'lines'
          ? removePenLines(pixels, width, height)
          : adaptiveThreshold(pixels, width, height);
  parentPort.postMessage(value);
}
