"""One page per isolated CPU process. No network model discovery or document logging."""
import importlib.metadata
import json
import os
import pathlib
import resource
import signal
import sys
import time

os.environ['CUDA_VISIBLE_DEVICES'] = ''
threads = int(sys.argv[5]) if len(sys.argv) > 5 else 1
if threads not in (1, 2, 4):
    raise ValueError('CPU threads must be 1, 2 or 4')
os.environ['OMP_NUM_THREADS'] = str(threads)
os.environ['MKL_NUM_THREADS'] = str(threads)
os.environ['OPENBLAS_NUM_THREADS'] = str(threads)
os.environ['PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK'] = 'True'
os.nice(10)


def main():
    if sys.argv[1] == '--info':
        versions = {dist.metadata['Name'].lower().replace('_', '-'): dist.version
                    for dist in importlib.metadata.distributions()}
        versions['__python__'] = sys.version
        print(json.dumps(versions))
        return
    image, models, output = map(pathlib.Path, sys.argv[1:4])
    signal.alarm(int(sys.argv[4]))
    started = time.monotonic()
    from paddleocr import PaddleOCR
    import cv2
    cv2.setNumThreads(threads)
    engine = PaddleOCR(
        text_detection_model_name='PP-OCRv6_small_det',
        text_detection_model_dir=str(models / 'PP-OCRv6_small_det_infer'),
        text_recognition_model_name='PP-OCRv6_small_rec',
        text_recognition_model_dir=str(models / 'PP-OCRv6_small_rec_infer'),
        # oneDNN in Paddle 3.3.1 cannot execute a PP-OCRv6 Small attribute on this CPU.
        device='cpu', cpu_threads=threads, enable_mkldnn=False,
        use_doc_orientation_classify=False, use_doc_unwarping=False,
        use_textline_orientation=False, text_recognition_batch_size=1,
        text_det_limit_side_len=1280, text_det_limit_type='max',
    )
    pages = engine.predict(str(image))
    if len(pages) != 1:
        raise RuntimeError('Expected exactly one page')
    result = pages[0]
    value = {
        'texts': result['rec_texts'],
        'polygons': [polygon.tolist() for polygon in result['rec_polys']],
        'scores': [float(score) for score in result['rec_scores']],
        'inferenceAndLoadMs': round((time.monotonic() - started) * 1000),
        'peakWorkingSetBytes': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
    }
    with output.open('w', encoding='utf-8') as target:
        os.chmod(output, 0o600)
        json.dump(value, target, ensure_ascii=False, allow_nan=False)


if __name__ == '__main__':
    main()
