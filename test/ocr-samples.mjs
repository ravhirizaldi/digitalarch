import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const samples = [
  {
    language: 'eng',
    name: '01-english.png',
    lines: [
      'DigitalArch OCR verification',
      'The original document remains unchanged.',
      'Invoice number 2026. Total amount 125000.',
    ],
  },
  {
    language: 'ind',
    name: '02-indonesian.png',
    lines: [
      'Verifikasi OCR DigitalArch',
      'Surat keterangan penerimaan dokumen.',
      'Nomor arsip 2026. Jumlah halaman tiga.',
    ],
  },
];
export async function writeOcrSamples(directory) {
  await mkdir(directory, { recursive: true });
  for (const sample of samples) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2550" height="3300"><rect width="2550" height="3300" fill="white"/><g fill="black" font-family="DejaVu Sans" font-size="58">${sample.lines.map((line, index) => `<text x="180" y="${300 + index * 130}">${line}</text>`).join('')}</g></svg>`;
    const png = await sharp(Buffer.from(svg)).png().withMetadata({ density: 300 }).toBuffer();
    await writeFile(path.join(directory, sample.name), png);
  }
}
