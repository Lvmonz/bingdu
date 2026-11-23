"""生成可提交的扩展 ZIP。运行 python3 store/package.py 即可。"""
import argparse
import json
import re
import tempfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from release_platform import output_directory

ROOT = Path(__file__).resolve().parents[1]


def build(root, output, version=None):
    root = root.resolve()
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    files = {
        "manifest.json", "caption-frames.js", "files.js", "page-access.js", "panel.js", "panel.css", "popup.css",
        "epub-export.js", "pdf-export.js", "reading-controls.js",
        "vendor/pdf.mjs", "vendor/pdf.worker.mjs", "vendor/pdf-lib.min.js", "vendor/fflate.mjs",
        "vendor/pdfjs.LICENSE", "vendor/pdf-lib.LICENSE", "vendor/fflate.LICENSE",
        manifest["background"]["service_worker"], manifest["action"]["default_popup"],
        manifest["options_page"], manifest["side_panel"]["default_path"],
        *manifest["icons"].values(), *manifest["action"]["default_icon"].values()
    }
    for script in manifest["content_scripts"]:
        files.update(script.get("js", []))
        files.update(script.get("css", []))
    if version:
        manifest["version"] = version
    output.mkdir(parents=True, exist_ok=True)
    destination = output / f'并读-{manifest["version"]}-Chrome商店.zip'
    with tempfile.TemporaryDirectory(dir=output) as temp:
        archive = Path(temp) / "package.zip"
        with ZipFile(archive, "w") as z:
            for name in sorted(files):
                path = root / name
                if not path.resolve().is_relative_to(root) or path.is_symlink():
                    raise ValueError(f"文件不在扩展源码内：{name}")
                data = path.read_bytes()
                if name == "manifest.json" and version:
                    data = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()
                if re.search(rb"sk-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----", data):
                    raise ValueError(f"文件包含疑似密钥：{name}")
                info = ZipInfo(name)
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                z.writestr(info, data, compress_type=ZIP_DEFLATED)
        with ZipFile(archive) as z:
            if set(z.namelist()) != files or z.testzip() is not None:
                raise ValueError("ZIP 完整性检查失败")
        archive.replace(destination)
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=output_directory(ROOT))
    print(build(ROOT, parser.parse_args().output))
