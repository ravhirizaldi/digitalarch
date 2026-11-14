import { createHash } from 'node:crypto';

export const metadataTypes = [
  'title',
  'subtitle',
  'document_number',
  'serial_number',
  'person',
  'company',
  'address',
  'date',
  'phone',
  'email',
  'identity_number',
  'tax_number',
  'position',
  'model',
  'service_id',
  'amount',
  'reference',
  'other',
];
export const metadataExtractorVersion = 1;

const labels = [
  [
    'company',
    'nama\\s+(?:perusahaan|badan\\s+usaha|instansi|organisasi)|company\\s+name|organization\\s+name',
  ],
  [
    'person',
    'nama(?:\\s+(?:lengkap|pemohon|penanggung\\s+jawab|direktur|pihak\\s+(?:pertama|kedua|ketiga)))?|full\\s+name|name',
  ],
  [
    'address',
    'alamat(?:\\s+(?:kantor|perusahaan|domisili|rumah))?|(?:office\\s+|company\\s+|registered\\s+)?address',
  ],
  ['serial_number', 'serial\\s*(?:number|no\\.?|#)|s[/.]n|nomor\\s+seri|no\\.?\\s+seri'],
  ['identity_number', '(?:no\\.?|nomor)?\\s*(?:ktp|nik|passport|paspor)(?:\\s+(?:no\\.?|number))?'],
  ['tax_number', '(?:(?:no\\.?|nomor)\\s*)?npwp|tax\\s+(?:id|number)'],
  [
    'document_number',
    '(?:nomor|no\\.?)(?:\\s+(?:surat|dokumen|perjanjian|kontrak))?|document\\s+(?:number|no\\.?)|contract\\s+(?:number|no\\.?)',
  ],
  [
    'phone',
    '(?:(?:no\\.?|nomor)\\s*)?(?:phone|telephone|telp|telepon|tel|fax|mobile|hp)(?:\\s*(?:no\\.?|number))?\\.?',
  ],
  ['email', '(?:alamat\\s+)?e-?mail(?:\\s+address)?'],
  ['position', 'jabatan|position|job\\s+title'],
  ['model', 'model(?:\\s+name)?|nama\\s+model'],
  ['service_id', 'service\\s+(?:id|number)|customer\\s+(?:id|number)|nomor\\s+pelanggan'],
  [
    'date',
    '(?:tanggal(?:\\s+(?:lahir|surat|perjanjian|efektif|berakhir))?|date(?:\\s+of\\s+birth)?|effective\\s+date|expiry\\s+date)',
  ],
  ['title', 'judul(?:\\s+(?:surat|dokumen))?|subject|perihal|hal'],
  [
    'amount',
    '(?:total(?:\\s+amount)?|jumlah\\s+(?:pembayaran|tagihan)|nilai\\s+kontrak|grand\\s+total)',
  ],
  ['reference', 'reference(?:\\s+(?:number|no\\.?))?|referensi'],
].map(([type, label]) => ({
  type,
  regex: new RegExp(
    `^\\s*(?:\\d{1,2}[.)]\\s*)?(${label})(?:\\s*[:：=]\\s*|\\s+(?=\\S)|$)(.*)$`,
    'iu',
  ),
}));
const clean = (text) => text.replace(/\s+/g, ' ').trim();
const labelAt = (text) => {
  let best = null;
  for (const { type, regex } of labels) {
    const match = text.match(regex);
    if (match && (!best || match[1].trim().length > best.label.length))
      best = { type, label: match[1].trim(), value: match[2].trim() };
  }
  return best;
};
const boundary = (text) =>
  /^(?:\d+[.)]\s|pasal\b|article\b|selanjutnya\b|bertindak\b|yang\s+bertanda\b|pada\s+hari\b|antara\b|dan$|pihak\s+(?:pertama|kedua|ketiga)\b)/iu.test(
    text,
  );
const placeholder = (text) => !text || /^[\s.:：_…—–-]+$/u.test(text);
const monthNames =
  'januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|january|february|march|may|june|july|august|october|december';
const months = {
  januari: 1,
  january: 1,
  februari: 2,
  february: 2,
  maret: 3,
  march: 3,
  april: 4,
  mei: 5,
  may: 5,
  juni: 6,
  june: 6,
  juli: 7,
  july: 7,
  agustus: 8,
  august: 8,
  september: 9,
  oktober: 10,
  october: 10,
  november: 11,
  desember: 12,
  december: 12,
};
const datePattern = `\\b\\d{1,2}\\s+(?:${monthNames})\\s+\\d{4}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}[/.]\\d{1,2}[/.]\\d{4}\\b|\\b\\d{1,2}-\\d{1,2}-\\d{4}\\b`;
const dateContext = (text) =>
  /lahir|birth/iu.test(text)
    ? 'Birth date'
    : /berakhir|expiry/iu.test(text)
      ? 'Expiry date'
      : /efektif|effective/iu.test(text)
        ? 'Effective date'
        : /ditandatangani|signed/iu.test(text)
          ? 'Signing date'
          : 'Date mentioned';

export function normalizeMetadataDate(value) {
  let year, month, day;
  const named = value
    .toLowerCase()
    .match(new RegExp(`^(\\d{1,2})\\s+(${monthNames})\\s+(\\d{4})$`, 'u'));
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (named) {
    day = Number(named[1]);
    month = months[named[2]];
    year = Number(named[3]);
  } else if (iso) [, year, month, day] = iso.map(Number);
  else return null; // Ambiguous numeric dates stay literal, never guessed.
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    : null;
}

export function extractMetadata({ extracted_text = '', structured_result } = {}) {
  const raw =
    Array.isArray(structured_result?.lines) &&
    structured_result.lines.some((line) => typeof line.text === 'string')
      ? structured_result.lines
      : (extracted_text || '').split(/\r?\n/u).map((text) => ({ text }));
  const lines = raw
    .filter((line) => typeof line.text === 'string' && line.text.trim())
    .map((line, index) => ({
      index,
      text: clean(line.text),
      bounds: line.bounds || null,
    }));
  const fields = [],
    warnings = [],
    used = new Set();
  function add(type, value, context, source) {
    value = clean(value.replace(/^\s*[:：=]\s*/u, ''));
    if (placeholder(value) || value.length > 2000 || fields.length >= 200) return;
    const key = `${type}:${source.map((line) => line.index).join(',')}:${value}`;
    if (
      fields.some(
        (field) => field.id === createHash('sha256').update(key).digest('hex').slice(0, 24),
      )
    )
      return;
    fields.push({
      id: createHash('sha256').update(key).digest('hex').slice(0, 24),
      type,
      value,
      context,
      normalized: type === 'date' ? normalizeMetadataDate(value) : null,
      source,
    });
  }
  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue;
    const line = lines[i],
      label = labelAt(line.text);
    if (!label) continue;
    let value = label.value;
    const source = [line];
    if (placeholder(value) && value) continue;
    // Some OCR engines return the value as a separate box on the same row.
    const right =
      !value &&
      line.bounds &&
      lines.findIndex(
        (candidate, j) =>
          j !== i &&
          !used.has(j) &&
          candidate.bounds &&
          candidate.bounds.x >= line.bounds.x + line.bounds.width &&
          Math.abs(
            candidate.bounds.y +
              candidate.bounds.height / 2 -
              line.bounds.y -
              line.bounds.height / 2,
          ) <
            Math.min(candidate.bounds.height, line.bounds.height) * 0.6 &&
          !labelAt(candidate.text),
      );
    if (right !== false && right != null && right >= 0) {
      value = lines[right].text;
      source.push(lines[right]);
      used.add(right);
    }
    const multiline = ['address', 'company', 'title'].includes(label.type);
    for (
      let j = i + 1;
      j < lines.length && source.length < (label.type === 'address' ? 9 : multiline ? 4 : 2);
      j++
    ) {
      const next = lines[j];
      if (used.has(j)) continue;
      const addressNumber = label.type === 'address' && /^no\.?\s*\d/iu.test(next.text);
      if ((!addressNumber && labelAt(next.text)) || boundary(next.text) || (value && !multiline))
        break;
      if (
        source.at(-1).bounds &&
        next.bounds &&
        next.bounds.y - source.at(-1).bounds.y > source.at(-1).bounds.height * 3
      )
        break;
      if (!multiline && next.text.length > 160) break;
      value = `${value} ${next.text.replace(/^[:：]\s*/u, '')}`.trim();
      source.push(next);
      used.add(j);
    }
    // A "Nama" value can itself explicitly identify an organization.
    const type =
      label.type === 'person' &&
      /^(?:pt\.?\s|cv\.?\s|koperasi\b|yayasan\b|perseroan\b)/iu.test(value)
        ? 'company'
        : label.type;
    if (type === 'date') {
      const matches = [...value.matchAll(new RegExp(datePattern, 'giu'))];
      if (matches.length)
        for (const match of matches)
          add(type, match[0], dateContext(`${label.label} ${value}`), source);
      else add(type, value, dateContext(label.label), source);
    } else add(type, value, label.label, source);
    used.add(i);
  }
  const dates = new RegExp(datePattern, 'giu');
  for (const line of lines) {
    for (const match of line.text.matchAll(dates)) {
      if (
        !fields.some(
          (field) =>
            field.type === 'date' &&
            field.value === match[0] &&
            field.source.some((s) => s.index === line.index),
        )
      ) {
        add('date', match[0], dateContext(line.text), [line]);
      }
    }
    if (
      !used.has(line.index) &&
      /^\(?\s*(?:pt\.?\s|cv\.?\s|koperasi\b|yayasan\b)/iu.test(line.text) &&
      line.text.length < 180 &&
      !/selanjutnya|disebut|bertindak/iu.test(line.text)
    )
      add('company', line.text.replace(/^\(\s*|\s*\)$/gu, ''), 'Organization mentioned', [line]);
    const represented = line.text.match(
      /\b(?:bertindak\s+atas\s+nama|acting\s+on\s+behalf\s+of)\s+((?:pt\.?\s|cv\.?\s|koperasi\b|yayasan\b).+?)(?=,?\s+selanjutnya\b|\s+atau\s+disingkat\b|$)/iu,
    );
    if (represented) add('company', represented[1], 'Organization represented', [line]);
    for (const match of line.text.matchAll(
      /[\p{L}\d.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\d-]+(?:\.[\p{L}\d-]+)+/gu,
    )) {
      if (!fields.some((field) => field.type === 'email' && field.value.includes(match[0])))
        add('email', match[0], 'Email mentioned', [line]);
    }
    if (
      /\b(?:rp\.?|idr|usd)\s*[\d][\d.,]*(?:\s*[,.-]+)?/iu.test(line.text) &&
      !used.has(line.index)
    ) {
      for (const match of line.text.matchAll(/\b(?:rp\.?|idr|usd)\s*[\d][\d.,]*/giu))
        add('amount', match[0], 'Amount mentioned', [line]);
    }
  }
  // Heading candidates are relative to text layout, not a particular document template.
  if (!fields.some((field) => field.type === 'title')) {
    const title = lines
      .slice(0, 25)
      .find(
        (line) =>
          !used.has(line.index) &&
          /^(?:surat\s+(?!ini\b)|perjanjian\b|kesepakatan\b|kontrak\b|berita\s+acara\b|invoice\b|purchase\s+order\b|printer\s+information\b|certificate\b|sertifikat\b|akta\b|laporan\b|kuitansi\b|kwitansi\b|nota\b|memorandum\b)/iu.test(
            line.text,
          ) &&
          line.text.length < 180,
      );
    if (title) {
      add('title', title.text, 'Heading candidate', [title]);
      const next = lines[title.index + 1];
      if (
        next &&
        !used.has(next.index) &&
        !labelAt(next.text) &&
        !boundary(next.text) &&
        next.text === next.text.toUpperCase() &&
        /\p{L}/u.test(next.text) &&
        next.text.length < 180
      )
        add('subtitle', next.text, 'Heading continuation', [next]);
    }
  }
  // Signature blocks: associate by column where bounds exist, not a fixed crop.
  for (const heading of lines.filter((line) =>
    /^PIHAK\s+(PERTAMA|KEDUA|KETIGA)\s*[:：]?$/iu.test(line.text),
  )) {
    const below = lines.filter(
      (line) =>
        line.index > heading.index &&
        !used.has(line.index) &&
        !boundary(line.text) &&
        !labelAt(line.text) &&
        (heading.bounds && line.bounds
          ? line.bounds.y > heading.bounds.y &&
            Math.abs(
              line.bounds.x + line.bounds.width / 2 - heading.bounds.x - heading.bounds.width / 2,
            ) < Math.max(heading.bounds.width, line.bounds.width)
          : line.index <= heading.index + 3),
    );
    const name = below.find(
      (line) =>
        /^[\p{L}][\p{L}\s.,'’()-]{2,100}$/u.test(line.text) &&
        !/^(?:pt\.?\s|cv\.?\s|koperasi|page\b|paraf\b)/iu.test(line.text),
    );
    if (name) {
      add('person', name.text, `Signature · ${heading.text}`, [heading, name]);
      used.add(name.index);
    }
  }
  for (const field of fields.filter(
    (field) =>
      ['person', 'company', 'address', 'position'].includes(field.type) &&
      !field.context.startsWith('Signature'),
  )) {
    const end = Math.max(...field.source.map((line) => line.index));
    const following = lines.slice(end + 1, end + 15);
    const boundaryIndex = following.findIndex(
      (line) => labelAt(line.text)?.type === 'person' || labelAt(line.text)?.type === 'company',
    );
    const party = following
      .slice(0, boundaryIndex < 0 ? undefined : boundaryIndex)
      .find((line) => /(?:disebut|selanjutnya).*pihak\s+(pertama|kedua|ketiga)/iu.test(line.text));
    if (party) field.context += ` · ${party.text.match(/pihak\s+(pertama|kedua|ketiga)/iu)[0]}`;
  }
  if (fields.some((field) => field.type === 'date' && !field.normalized))
    warnings.push(
      'Some dates are ambiguous or not a valid calendar date; their original text was retained.',
    );
  if (lines.some((line) => /^(?:nomor|no\.?)\s*[:：]\s*[.\s_…-]+$/iu.test(line.text)))
    warnings.push('A document-number slot appears blank; no number was invented.');
  return { extractorVersion: metadataExtractorVersion, fields, warnings };
}

const comparisonKey = (value) =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase('id')
    .replace(/\s+/gu, ' ')
    .replace(/\s*([/.-])\s*/gu, '$1')
    .trim();
function closeSpelling(a, b) {
  if (a.length < 6 || b.length < 6) return false;
  const limit = Math.max(1, Math.min(3, Math.floor(Math.max(a.length, b.length) * 0.08)));
  if (!limit || Math.abs(a.length - b.length) > limit) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    if (Math.min(...current) > limit) return false;
    previous = current;
  }
  return previous[b.length] <= limit;
}

export function mergeMetadata(pages) {
  const fields = [],
    warnings = new Set();
  let truncated = false;
  const printedTotals = new Set();
  for (const page of pages) {
    for (const match of (page.extracted_text || '').matchAll(
      /\b(?:page|halaman)\s+\d+\s+(?:of|dari)\s+(\d+)\b/giu,
    ))
      printedTotals.add(Number(match[1]));
    const extracted = extractMetadata(page);
    for (const warning of extracted.warnings) warnings.add(`Page ${page.page_number}: ${warning}`);
    for (const candidate of extracted.fields) {
      const key = comparisonKey(candidate.normalized || candidate.value);
      const eligible = fields.filter(
        (field) =>
          field.type === candidate.type &&
          (candidate.type !== 'date' || field.context === candidate.context) &&
          (candidate.type !== 'identity_number' ||
            field.context.toLowerCase() === candidate.context.toLowerCase()),
      );
      let field = eligible.find((field) =>
        field.alternatives.some((alt) => comparisonKey(alt.normalized || alt.value) === key),
      );
      if (
        !field &&
        ['person', 'company', 'address', 'title', 'subtitle'].includes(candidate.type)
      ) {
        const possible = eligible.filter((field) =>
          field.alternatives.some((alt) => closeSpelling(comparisonKey(alt.value), key)),
        );
        if (possible.length === 1) field = possible[0];
      }
      if (!field) {
        if (fields.length >= 200) {
          truncated = true;
          continue;
        }
        field = {
          ...candidate,
          id: createHash('sha256')
            .update(`${page.result_id}:${candidate.id}`)
            .digest('hex')
            .slice(0, 24),
          source: [],
          alternatives: [],
          contexts: [],
          occurrences: 0,
          pageCount: 0,
        };
        fields.push(field);
      }
      if (!field.contexts.includes(candidate.context)) field.contexts.push(candidate.context);
      const source = candidate.source.map((line) => ({
        ...line,
        pageId: page.page_id,
        pageNumber: page.page_number,
        pageOffset: page.page_offset,
        resultId: page.result_id,
      }));
      // Count one detection per source block, not one vote for each wrapped line.
      const occurrence = `${page.result_id}:${candidate.source[0]?.index}`;
      let alternative = field.alternatives.find(
        (alt) => comparisonKey(alt.normalized || alt.value) === key,
      );
      if (!alternative) {
        alternative = {
          value: candidate.value,
          normalized: candidate.normalized,
          occurrences: [],
          pages: [],
          source: [],
        };
        field.alternatives.push(alternative);
      }
      if (!alternative.occurrences.includes(occurrence)) {
        alternative.occurrences.push(occurrence);
        if (!alternative.pages.includes(page.page_number)) alternative.pages.push(page.page_number);
        alternative.source.push(...source);
      }
    }
  }
  for (const field of fields) {
    field.alternatives.sort(
      (a, b) =>
        b.pages.length - a.pages.length ||
        b.occurrences.length - a.occurrences.length ||
        a.value.localeCompare(b.value),
    );
    field.value = field.alternatives[0].value;
    field.normalized = field.alternatives[0].normalized;
    field.source = field.alternatives.flatMap((alt) => alt.source);
    field.occurrences = field.alternatives.reduce((n, alt) => n + alt.occurrences.length, 0);
    field.pageCount = new Set(field.alternatives.flatMap((alt) => alt.pages)).size;
    field.context = field.contexts.join(' · ').slice(0, 240);
    field.alternatives = field.alternatives.map(({ occurrences, ...alt }) => ({
      ...alt,
      count: occurrences.length,
    }));
    if (field.alternatives.length > 1)
      warnings.add(
        'Similar spellings were grouped as alternatives. Page agreement is evidence, not proof; check each against the source.',
      );
  }
  fields.sort((a, b) => b.pageCount - a.pageCount || b.occurrences - a.occurrences);
  if ([...printedTotals].some((total) => total > pages.length))
    warnings.add(
      'Printed pagination suggests more pages than the completed OCR pages in this run. Check document completeness.',
    );
  for (const party of ['pertama', 'kedua', 'ketiga']) {
    if (
      fields.filter(
        (field) =>
          field.type === 'person' && new RegExp(`pihak\\s+${party}`, 'iu').test(field.context),
      ).length > 1
    )
      warnings.add(
        `Different personal names are associated with PIHAK ${party.toUpperCase()}; verify their roles instead of choosing one automatically.`,
      );
  }
  if (truncated)
    warnings.add(
      'Only the first 200 distinct metadata groups are shown; review the remaining recognized text.',
    );
  return { extractorVersion: metadataExtractorVersion, fields, warnings: [...warnings] };
}
