import { failure } from './errors.mjs';

export const ocrProfiles = ['standard', 'enhanced', 'high-accuracy'];
export function processingConfig({
  profile = 'standard',
  psm = 3,
  preprocessing = {},
  layout = 'page',
  engine = 'tesseract',
  model,
  cpuThreads,
} = {}) {
  if (cpuThreads !== undefined && (engine !== 'paddleocr' || ![1, 2, 4].includes(cpuThreads)))
    throw failure(
      'invalid_request',
      'PaddleOCR supports a CPU thread budget of 1, 2 or 4. Tesseract thread control is not exposed by this adapter.',
    );
  if (
    !['tesseract', 'paddleocr'].includes(engine) ||
    (model !== undefined && (engine !== 'paddleocr' || model !== 'PP-OCRv6 Small')) ||
    (engine === 'paddleocr' && (layout !== 'page' || psm !== 3))
  )
    throw failure(
      'invalid_request',
      'Choose a supported OCR engine/model. PaddleOCR uses its own page detector, not Tesseract PSM or region layout.',
    );
  if (
    !ocrProfiles.includes(profile) ||
    ![3, 4, 6].includes(psm) ||
    !['page', 'regions'].includes(layout) ||
    !preprocessing ||
    typeof preprocessing !== 'object' ||
    Array.isArray(preprocessing)
  )
    throw failure('invalid_request', 'Choose a listed OCR profile and PSM 3, 4 or 6.');
  const enhanced = profile !== 'standard';
  const steps = {
    grayscale: enhanced,
    contrast: enhanced,
    deskew: enhanced,
    denoise: enhanced,
    adaptiveThreshold: profile === 'high-accuracy',
  };
  for (const [key, value] of Object.entries(preprocessing)) {
    if ((!Object.hasOwn(steps, key) && key !== 'lineRemoval') || typeof value !== 'boolean')
      throw failure('invalid_request', 'Invalid OCR preprocessing setting.');
    steps[key] = value;
  }
  const regionPipeline = layout === 'regions' || Object.hasOwn(steps, 'lineRemoval');
  return {
    version: engine === 'paddleocr' ? (cpuThreads === undefined ? 3 : 4) : regionPipeline ? 2 : 1,
    profile,
    quality: 'best',
    psm,
    dpi: 300,
    preprocessing: steps,
    ...(regionPipeline ? { layout } : {}),
    ...(engine === 'paddleocr' ? { engine, model: 'PP-OCRv6 Small' } : {}),
    ...(cpuThreads !== undefined ? { cpuThreads } : {}),
  };
}
