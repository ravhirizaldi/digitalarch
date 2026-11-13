import { windowsOcrProvider } from './ocr-provider.mjs';
import { paddleOcrProvider, paddleModel } from './ocr-paddle.mjs';

export function ocrProvider(settings) {
  const engines = {
    tesseract: windowsOcrProvider(settings),
    paddleocr: paddleOcrProvider(settings),
  };
  const engine = (config) => engines[config?.engine || 'tesseract'];
  return {
    info: (language, signal, config = settings.processingConfig) =>
      engine(config).info(language, signal, config),
    process: (buffer, page, language, signal, config = settings.processingConfig) =>
      engine(config).process(buffer, page, language, signal, config),
    async catalog() {
      const config = { ...settings.processingConfig, engine: 'paddleocr', model: paddleModel };
      let paddle;
      try {
        paddle = await engines.paddleocr.info('ind+eng', undefined, config);
      } catch (error) {
        paddle = { error: error.message };
      }
      return {
        defaultEngine: settings.processingConfig.engine || 'tesseract',
        engines: [
          {
            id: 'tesseract',
            name: 'Tesseract (NAPS2)',
            model: 'Best · Indonesian + English',
            available: true,
          },
          {
            id: 'paddleocr',
            name: 'PaddleOCR',
            model: paddleModel,
            available: !paddle.error,
            version: paddle.engineVersion,
            device: 'CPU',
            error: paddle.error,
          },
        ],
      };
    },
  };
}
