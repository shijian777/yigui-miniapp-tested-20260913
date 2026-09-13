"""Create an importable source ZIP without historical H5 demos and stale QR codes."""
from pathlib import Path
import argparse
import zipfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("output", nargs="?", default=str(root.parent / "衣柜小程序-源码.zip"))
args = parser.parse_args()
output = Path(args.output).expanduser().resolve()
skip_dirs = {".git", "node_modules", "h5", "artifacts", "__pycache__"}
skip_files = {".DS_Store", "my-experience-qr.png", "my-preview-info.json", "preview-info.json", "project.private.config.json"}
files = [p for p in root.rglob("*") if p.is_file() and not skip_dirs.intersection(p.relative_to(root).parts)
         and p.name not in skip_files and p.resolve() != output and not p.name.endswith(".log")]
output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(files):
        archive.write(file, Path(root.name) / file.relative_to(root))
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    assert root.name + "/app.json" in archive.namelist()
print(f"已生成 {output}，{len(files)} 个文件，{output.stat().st_size:,} 字节")
