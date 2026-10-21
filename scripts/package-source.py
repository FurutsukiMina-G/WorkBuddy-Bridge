"""Build a source-only release from the canonical project directory."""
from pathlib import Path
import os
import zipfile

root = Path(__file__).resolve().parent.parent
releases = root / 'releases'
releases.mkdir(exist_ok=True)
archive = releases / 'WorkBuddy-Bridge-source.zip'
excluded = {'.runtime', 'reports', 'node_modules', '.git', 'releases'}
key_file = root / '.runtime' / 'bridge-key'
key = key_file.read_bytes().strip() if key_file.exists() else b''
count = 0
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
    for directory, dirs, names in os.walk(root):
        dirs[:] = [name for name in dirs if name not in excluded and not (Path(directory) / name).is_symlink()]
        for name in names:
            path = Path(directory) / name
            if path.suffix.lower() == '.zip' or path.is_symlink():
                continue
            data = path.read_bytes()
            if key and key in data:
                raise RuntimeError('Local credential found in source archive input')
            bundle.writestr(root.name + '/' + path.relative_to(root).as_posix(), data)
            count += 1
with zipfile.ZipFile(archive) as bundle:
    assert bundle.testzip() is None
print(f'Created {archive}: {count} source files; private runtime, logs and dependencies excluded.')
