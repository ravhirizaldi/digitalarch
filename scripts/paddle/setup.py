"""Explicit local CPU installation; never called by the OCR worker."""
import hashlib
import json
import pathlib
import subprocess
import tarfile
import urllib.request
import venv

ROOT = pathlib.Path(__file__).resolve().parents[2]
HOME = ROOT / '.local' / 'paddleocr'
MODELS = {
    'PP-OCRv6_small_det': (10055680, 'bfb7c1e59f0faa6b540ebdca93aea3f4b1f2477805b389fbee117820d68fe9f5'),
    'PP-OCRv6_small_rec': (21442560, 'da460f968ce9f88325ac3a34fa302077d6e9b0dcefb16ba3137cd7796f879d06'),
}


def main():
    HOME.mkdir(parents=True, exist_ok=True, mode=0o700)
    python = HOME / 'venv' / 'bin' / 'python'
    if not python.exists():
        venv.EnvBuilder(with_pip=True).create(HOME / 'venv')
    subprocess.run([str(python), '-m', 'pip', 'install', '-r',
                    str(pathlib.Path(__file__).with_name('requirements.txt'))], check=True)
    manifest = {}
    for name, (size, sha256) in MODELS.items():
        url = ('https://paddle-model-ecology.bj.bcebos.com/paddlex/'
               f'official_inference_model/paddle3.0.0/{name}_infer.tar')
        archive = HOME / f'{name}.tar'
        if not archive.exists():
            partial = archive.with_suffix('.partial')
            urllib.request.urlretrieve(url, partial)
            if partial.stat().st_size != size:
                raise RuntimeError(f'Unexpected archive size: {name}')
            partial.rename(archive)
        if archive.stat().st_size != size:
            raise RuntimeError(f'Unexpected archive size: {name}')
        if hashlib.sha256(archive.read_bytes()).hexdigest() != sha256:
            raise RuntimeError(f'Model archive checksum mismatch: {name}')
        with tarfile.open(archive) as package:
            members = package.getmembers()
            if any(not (m.name == name + '_infer' or m.name.startswith(name + '_infer/')) or
                   not (m.isfile() or m.isdir()) for m in members):
                raise RuntimeError('Unexpected model archive members')
            package.extractall(HOME / 'models', filter='data')
        manifest[name] = {'url': url, 'bytes': size,
                          'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}
    (HOME / 'downloads.json').write_text(json.dumps(manifest, indent=2) + '\n')
    with (HOME / 'installed-requirements.txt').open('w') as target:
        subprocess.run([str(python), '-m', 'pip', 'freeze'], stdout=target, check=True)
    print('Local CPU runtime and Small detection/recognition models installed. Default unchanged.')


if __name__ == '__main__':
    main()
