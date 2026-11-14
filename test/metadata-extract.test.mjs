import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractMetadata,
  mergeMetadata,
  normalizeMetadataDate,
} from '../server/metadata-extract.mjs';

// Synthetic text only; running these OCR-metadata tests still requires user approval.
test('metadata: split numbered company/address labels and multiple parties retain provenance', () => {
  const result = extractMetadata({
    extracted_text: `SURAT PERJANJIAN KERJASAMA
PENYEDIAAN LAYANAN
Nomor: TEST/ABC/2026
Nomor : ................
1. Nama Perusahaan
: PT. Contoh Mesin Indonesia
2. Alamat
Kawasan Contoh Blok B
No. 9, Kota Contoh 12345
Selanjutnya disebut sebagai "PIHAK PERTAMA"
1. Nama Perusahaan
: PT. Contoh Arsip
2. Alamat
: Gedung Contoh lantai 2
Jalan Contoh No. 8
Selanjutnya disebut sebagai "PIHAK KEDUA"
Nama: Rina Contoh
Jabatan: Direktur
No KTP: 123456789012345
Phone No.: 021 555000
Email: arsip@example.invalid`,
  });
  const by = (type) => result.fields.filter((field) => field.type === type);
  assert.equal(by('company').length, 2);
  assert.equal(by('person')[0].value, 'Rina Contoh');
  assert.equal(by('address')[0].value, 'Kawasan Contoh Blok B No. 9, Kota Contoh 12345');
  assert.match(by('address')[0].context, /PIHAK PERTAMA/);
  assert.equal(by('document_number').length, 1);
  assert.equal(by('document_number')[0].value, 'TEST/ABC/2026');
  assert.equal(by('identity_number')[0].value, '123456789012345');
  assert.equal(by('phone')[0].value, '021 555000');
  assert.equal(by('email')[0].value, 'arsip@example.invalid');
  assert.equal(by('title')[0].value, 'SURAT PERJANJIAN KERJASAMA');
  assert.equal(by('subtitle')[0].value, 'PENYEDIAAN LAYANAN');
  assert.ok(result.warnings.some((warning) => /blank/.test(warning)));
  assert.ok(by('company').every((field) => field.source.length >= 2));
});

test('metadata: serial/model/service labels, geometry and dates do not invent corrections', () => {
  const result = extractMetadata({
    structured_result: {
      lines: [
        { text: 'Serial Number: ZX1000A749' },
        { text: 'Model Name: Example Printer' },
        { text: 'Service ID: 12006' },
        { text: 'Nama', bounds: { x: 10, y: 100, width: 60, height: 20 } },
        { text: ': Dewi Contoh', bounds: { x: 120, y: 101, width: 180, height: 20 } },
        { text: 'Tanggal lahir: 29 Februari 2024' },
        { text: 'Ditandatangani 15 November 2026' },
        { text: 'Periode 01/02/2026 sampai 03/04/2026' },
        { text: 'Nilai kontrak: Rp 1.000.000' },
      ],
    },
  });
  assert.equal(result.fields.find((field) => field.type === 'serial_number').value, 'ZX1000A749');
  assert.equal(result.fields.find((field) => field.type === 'model').value, 'Example Printer');
  assert.equal(result.fields.find((field) => field.type === 'service_id').value, '12006');
  const name = result.fields.find((field) => field.type === 'person');
  assert.equal(name.value, 'Dewi Contoh');
  assert.equal(name.source[1].bounds.x, 120);
  assert.equal(result.fields.filter((field) => field.type === 'date').length, 4);
  assert.equal(
    result.fields.find((field) => field.context === 'Birth date').normalized,
    '2024-02-29',
  );
  assert.equal(normalizeMetadataDate('31 Februari 2024'), null);
  assert.equal(normalizeMetadataDate('01/02/2026'), null);
  assert.equal(normalizeMetadataDate('2026-11-15'), '2026-11-15');
});

test('metadata: all-page merge ranks page agreement, retains spelling alternatives and never fuzzy-merges identifiers', () => {
  const page = (number, extracted_text) => ({
    page_id: `p${number}`,
    result_id: `r${number}`,
    page_number: number,
    page_offset: number - 1,
    extracted_text,
  });
  const result = mergeMetadata([
    page(1, 'Nama: Rina Contoh\nSerial Number: ZX1000A749\nNomor: TEST/001\nPage 1 of 9'),
    page(2, 'Nama: Rina Contoh\nSerial Number: ZX1000A749\nNomor: TEST/001'),
    page(3, 'Nama: Rina Contob\nSerial Number: ZX1000A748\nNomor: TEST/002\nNama: Orang Lain'),
  ]);
  const person = result.fields.find(
    (field) => field.type === 'person' && field.value === 'Rina Contoh',
  );
  assert.equal(person.pageCount, 3);
  assert.equal(person.alternatives.length, 2);
  assert.equal(person.alternatives[0].pages.length, 2);
  assert.equal(person.alternatives[1].value, 'Rina Contob');
  assert.equal(person.source[2].pageId, 'p3');
  assert.equal(result.fields.filter((field) => field.type === 'serial_number').length, 2);
  assert.equal(result.fields.filter((field) => field.type === 'document_number').length, 2);
  assert.equal(result.fields.filter((field) => field.type === 'person').length, 2);
  assert.ok(result.warnings.some((warning) => /pagination/.test(warning)));
  assert.ok(result.warnings.some((warning) => /not proof/.test(warning)));
});

test('metadata: repeating one page is not more support than agreement across two pages', () => {
  const result = mergeMetadata([
    {
      page_id: 'one',
      result_id: 'one',
      page_number: 1,
      extracted_text: 'Nama: Rina Contob\nNama: Rina Contob\nNama: Rina Contob',
    },
    { page_id: 'two', result_id: 'two', page_number: 2, extracted_text: 'Nama: Rina Contoh' },
    { page_id: 'three', result_id: 'three', page_number: 3, extracted_text: 'Nama: Rina Contoh' },
  ]);
  assert.equal(result.fields[0].value, 'Rina Contoh');
  assert.equal(result.fields[0].alternatives[0].count, 2);
  assert.equal(result.fields[0].alternatives[1].count, 3);
});
