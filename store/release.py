"""并读 Chrome Web Store v2 更新工具。无参数时上传并提审。"""
import argparse
import hashlib
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from package import ROOT, build
from release_platform import output_directory, release_lock, state_directory
from store_auth import access_token

PUBLISHER = "e3df8fd1-c30c-4b89-94f0-b7b721ad8f3b"
ITEM = "jilajlmefcnojfdchlablflkbdngopph"
RESOURCE = f"publishers/{PUBLISHER}/items/{ITEM}"
HOST = "https://chromewebstore.googleapis.com"
DASHBOARD = f"https://chrome.google.com/webstore/devconsole/{PUBLISHER}/{ITEM}/edit/status"
# 已在此条目上传的首版；首次草稿可能没有 publishedItemRevisionStatus。
FIRST_UPLOAD = "0.4.3"
ACCEPTED = {"PENDING_REVIEW", "PUBLISHED", "STAGED", "PUBLISHED_TO_TESTERS"}
STATE_NAMES = {"PENDING_REVIEW": "待 Google 审核", "PUBLISHED": "已发布", "STAGED": "审核通过，等待发布",
               "PUBLISHED_TO_TESTERS": "已向测试者发布", "REJECTED": "审核未通过", "CANCELLED": "已取消",
               "SUBMISSION_RECEIVED": "Google 已接收提审请求，具体审核状态请查看商店后台"}


def version_key(value):
    pieces = value.split(".")
    if not 1 <= len(pieces) <= 4 or any(not n.isascii() or not n.isdecimal() or str(int(n)) != n or int(n) > 65535 for n in pieces):
        raise ValueError(f"Chrome 版本号无效：{value}")
    return tuple(int(n) for n in pieces) + (0,) * (4 - len(pieces))


def next_version(value):
    version_key(value)
    parts = list(map(int, value.split(".")))
    for i in reversed(range(len(parts))):
        if parts[i] < 65535:
            parts[i] += 1
            return ".".join(map(str, parts))
        parts[i] = 0
    raise ValueError("版本号已达到上限。")


def atomic_json(path, content):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n", dir=path.parent, delete=False) as f:
        json.dump(content, f, ensure_ascii=False, indent=2)
        f.write("\n")
    temp = Path(f.name)
    if path.exists():
        temp.chmod(path.stat().st_mode & 0o777)
    temp.replace(path)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class StoreError(RuntimeError):
    def __init__(self, code, description):
        super().__init__(f"Google 商店返回 HTTP {code}：{description}")
        self.code = code
        self.description = description


class Store:
    def __init__(self, token):
        self.token = token

    def call(self, method, payload=None):
        upload = method == "upload"
        url = HOST + ("/upload" if upload else "") + "/v2/" + RESOURCE + ":" + method
        headers = {"Authorization": "Bearer " + self.token}
        if payload is not None:
            headers["Content-Type"] = "application/zip" if upload else "application/json"
        try:
            with urlopen(Request(url, data=payload, headers=headers), timeout=90) as response:
                result = json.load(response)
        except HTTPError as error:
            try:
                message = json.loads(error.read()).get("error", {}).get("message", str(error.reason))
            except (ValueError, AttributeError):
                message = str(error.reason)
            raise StoreError(error.code, message) from None
        if result.get("itemId") != ITEM and result.get("name") != RESOURCE:
            raise RuntimeError("Google 返回的条目标识无法核实，已停止。")
        return result

    def status(self):
        return self.call("fetchStatus")


def revisions(status):
    result = {}
    for field in ("publishedItemRevisionStatus", "submittedItemRevisionStatus"):
        revision = status.get(field, {})
        for channel in revision.get("distributionChannels", []):
            if channel.get("crxVersion"):
                result[channel["crxVersion"]] = revision.get("state")
    return result


def run(store, root, data, desktop):
    journal = data / "release.json"
    current = json.loads(journal.read_text(encoding="utf-8")) if journal.exists() else {}
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    remote = store.status()
    versions = revisions(remote)
    submitted = remote.get("submittedItemRevisionStatus", {}).get("state")
    last = current.get("version")
    old_state = versions.get(last)
    phase = current.get("phase", "done")

    def save(phase):
        current["phase"] = phase
        atomic_json(journal, current)

    def complete(state):
        local = json.loads(manifest_path.read_text(encoding="utf-8"))
        if version_key(local["version"]) < version_key(current["version"]):
            with tempfile.TemporaryDirectory() as tmp:
                matches = digest(build(root, Path(tmp), current["version"])) == current["sha256"]
            if matches:
                local["version"] = current["version"]
                atomic_json(manifest_path, local)
            else:
                print("当前源码已改变，刚提交的是上次保存的 ZIP。请保留新改动供下次发版。")
        current["state"] = state
        save("done")
        print(f"并读 {current['version']}：{STATE_NAMES.get(state, state)}。", DASHBOARD)

    if last and phase in {"publishing", "publish_blocked"} and old_state in ACCEPTED:
        complete(old_state)
        return
    if phase != "done" and old_state in {"REJECTED", "CANCELLED"}:
        save("done")
        phase = "done"
    if submitted in {"PENDING_REVIEW", "STAGED"}:
        print(f"原条目已有版本{STATE_NAMES[submitted]}，本次未另行上传。", DASHBOARD)
        return
    if phase != "done" and last and any(version_key(v) >= version_key(last) for v in versions):
        # Another release may have advanced this same item while this computer was offline.
        phase = "done"
    if phase == "version_taken":
        phase = "done"
    if phase in {"invalid", "publish_blocked"}:
        with tempfile.TemporaryDirectory() as tmp:
            changed = digest(build(root, Path(tmp), last)) != current["sha256"]
        if changed:
            # Keep a new source snapshot separate from any ZIP Google already processed.
            phase = "done"
        elif phase == "publish_blocked":
            save("uploaded")
        else:
            save("ready")
    if phase == "done":
        if last and current.get("phase") == "done" and old_state not in {"REJECTED", "CANCELLED"}:
            with tempfile.TemporaryDirectory() as tmp:
                if digest(build(root, Path(tmp), last)) == current["sha256"]:
                    print(f"运行文件与已经提交的 {last} 相同。", DASHBOARD)
                    return
        known_versions = [*versions]
        if last:
            known_versions.append(last)
        if not known_versions:
            # The API may confirm the item but omit both revision fields on a fresh computer.
            known_versions.append(manifest["version"])
        base = max(FIRST_UPLOAD, *known_versions, key=version_key)
        version = max(next_version(base), manifest["version"], key=version_key)
        archive = build(root, data, version)
        current = {"version": version, "sha256": digest(archive), "root": str(root)}
        save("ready")
    elif current.get("root") != str(root):
        with tempfile.TemporaryDirectory() as tmp:
            if digest(build(root, Path(tmp), current["version"])) != current["sha256"]:
                raise RuntimeError("上次发版尚未完成。请从包含该次源码的工作目录重试，以继续提交已保存的 ZIP。")
        current["root"] = str(root)
        save(current["phase"])
    version = current["version"]
    archive = data / f"并读-{version}-Chrome商店.zip"
    if digest(archive) != current["sha256"]:
        raise RuntimeError("上次保存的发布包校验失败，已停止。")
    desktop.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=desktop) as tmp:
        visible = Path(tmp) / archive.name
        shutil.copyfile(archive, visible)
        visible.replace(desktop / archive.name)
    print(f"版本 {version}，发布包 {desktop / archive.name}", flush=True)

    if current["phase"] in {"ready", "sending"}:
        save("sending")
        try:
            result = store.call("upload", archive.read_bytes())
        except StoreError as error:
            message = error.description.lower()
            if error.code in {400, 409} and "version" in message and any(
                hint in message for hint in ("already", "increase", "greater", "higher", "larger", "duplicate")
            ):
                save("version_taken")
                raise RuntimeError(f"{error}。下次双击会使用更高版本重新上传并核对包，不会提交未确认的草稿。") from None
            if error.code in {400, 413, 422}:
                save("invalid")
            raise
        state = result.get("uploadState")
        if state == "IN_PROGRESS":
            save("processing")
        elif state == "SUCCEEDED" and result.get("crxVersion") == version:
            save("uploaded")
        else:
            raise RuntimeError(f"上传未确认。预期 {version}，Google 返回 {state} / {result.get('crxVersion')}。")
    if current["phase"] == "processing":
        for poll in range(40):
            upload_state = store.status().get("lastAsyncUploadState")
            if upload_state == "SUCCEEDED":
                save("uploaded")
                break
            if upload_state == "FAILED":
                save("ready")
                raise RuntimeError("Google 处理 ZIP 失败；重新双击可重传同一包。")
            if upload_state in {"NOT_FOUND", None} and poll >= 3:
                save("sending")
                raise RuntimeError("Google 未保留异步上传状态；重新双击会核对并重传原包。")
            time.sleep(3)
        else:
            raise RuntimeError("Google 仍在处理 ZIP；下次双击会继续检查本次上传。")
    save("publishing")
    try:
        result = store.call("publish", b'{"publishType":"DEFAULT_PUBLISH"}')
    except StoreError as error:
        if 400 <= error.code < 500:
            save("publish_blocked")
        raise
    state = result.get("state")
    if state is None:
        # 首次上架时，Google 可能只回传条目标识。成功回执与具体审核状态分别记录。
        complete("SUBMISSION_RECEIVED")
        return
    if state not in ACCEPTED:
        raise RuntimeError(f"提审尚未确认，Google 状态为 {state}。下次双击会先核对后台。")
    complete(state)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--authorize-only", action="store_true", help="仅配置授权并验证原条目访问权限")
    mode.add_argument("--status", action="store_true", help="查看原条目已发布和已提交的版本")
    parser.add_argument("--client", type=Path, help="首次配置使用的桌面 OAuth 客户端 JSON")
    parser.add_argument("--session-only", action="store_true", help="仅本次使用 Google 授权，无需系统凭据库")
    parser.add_argument("--output", type=Path, help="发布包输出目录，默认使用桌面，无桌面时使用源码目录下的 dist")
    args = parser.parse_args(argv)
    data = state_directory()
    with release_lock(data):
        store = Store(access_token(args.client, args.session_only))
        if args.authorize_only:
            store.status()
            print("Google 授权成功，已验证并读原条目。")
        elif args.status:
            status = store.status()
            if not any(status.get(key) for key in ("publishedItemRevisionStatus", "submittedItemRevisionStatus")):
                print("已确认并读原条目。Google 此次未返回版本或审核状态，当前是否在审请到商店后台核对。")
            for key, label in (("publishedItemRevisionStatus", "已发布记录"), ("submittedItemRevisionStatus", "提交记录")):
                record = status.get(key)
                if record:
                    state = record.get("state", "状态未返回")
                    numbers = [entry["crxVersion"] for entry in record.get("distributionChannels", []) if entry.get("crxVersion")]
                    print(f"{label}（{'、'.join(numbers) or '版本号未返回'}）：{STATE_NAMES.get(state, state)}。")
            print(DASHBOARD)
        else:
            run(store, ROOT, data, args.output or output_directory(ROOT))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError, EOFError, URLError) as error:
        sys.exit(f"{error}\n商店状态：{DASHBOARD}")
