"""使用桌面 OAuth 和当前用户的系统凭据库授权。"""
import base64
import hashlib
import hmac
import json
import secrets
import subprocess
import sys
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen

SCOPE = "https://www.googleapis.com/auth/chromewebstore"
SERVICE = "Bingdu.ChromeWebStore.OAuth"
KEY_ACCOUNT = "jilajlmefcnojfdchlablflkbdngopph"
TOKEN_URL = "https://oauth2.googleapis.com/token"


def system_vault():
    try:
        if sys.platform == "win32":
            from keyring.backends.Windows import WinVaultKeyring
            vault = WinVaultKeyring()
            vault.persist = "local machine"
            return vault
        if sys.platform.startswith("linux"):
            from keyring.backends.SecretService import Keyring
            return Keyring()
    except ImportError:
        raise RuntimeError("请先为当前 Python 安装 store/requirements.txt，或使用 --session-only 本次授权。") from None
    raise RuntimeError("此平台请使用 --session-only 本次授权。")


def keychain_read():
    if sys.platform != "darwin":
        vault = system_vault()
        try:
            value = vault.get_password(SERVICE, KEY_ACCOUNT)
        except Exception:
            raise RuntimeError("系统凭据库不可用，请解锁后重试，或使用 --session-only 本次授权。") from None
        return json.loads(value) if value else None
    result = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", SERVICE,
                             "-a", KEY_ACCOUNT, "-w"], capture_output=True)
    if result.returncode == 44:  # errSecItemNotFound
        return None
    if result.returncode:
        raise RuntimeError("无法读取 macOS 登录钥匙串，请解锁后重试。")
    return json.loads(base64.urlsafe_b64decode(result.stdout.strip()))


def keychain_write(credentials):
    if sys.platform != "darwin":
        vault = system_vault()
        try:
            vault.set_password(SERVICE, KEY_ACCOUNT, json.dumps(credentials))
        except Exception:
            raise RuntimeError("授权成功但写入系统凭据库失败，请解锁后重试，或使用 --session-only。") from None
        return
    encoded = base64.urlsafe_b64encode(json.dumps(credentials).encode()).decode()
    # Interactive stdin keeps the secret off the process command line.
    command = f"add-generic-password -U -s {SERVICE} -a {KEY_ACCOUNT} -w {encoded}\n"
    result = subprocess.run(["/usr/bin/security", "-i"], input=command, text=True, capture_output=True)
    if result.returncode or keychain_read() != credentials:
        raise RuntimeError("Google 已授权，但钥匙串写入失败。请解锁钥匙串后重试。")


def exchange(form):
    try:
        with urlopen(Request(TOKEN_URL, data=urlencode(form).encode()), timeout=30) as response:
            return json.load(response)
    except HTTPError as error:
        reply = json.loads(error.read())
        if reply.get("error") == "invalid_grant":
            raise PermissionError("Google 授权已过期或被撤销。") from None
        raise RuntimeError(f"Google OAuth 返回 {error.code}：{reply.get('error', '授权失败')}") from None


def choose_client():
    enable = "https://console.cloud.google.com/apis/library/chromewebstore.googleapis.com"
    clients = "https://console.cloud.google.com/auth/clients"
    print(f"""首次配置（完成一次后双击即可发版）
1. 选择你的 Google Cloud 项目，启用 Chrome Web Store API：{enable}
2. 在 Google Auth Platform 设置应用名称、支持邮箱和 Audience。如选择 External / Testing，请把商店发布账号加到 Test users。Data Access 中添加 {SCOPE}。
3. 打开 {clients}，创建“桌面应用”OAuth 客户端并下载 JSON。请使用拥有此商店条目权限的账号登录稍后的 Google 授权页。
外部应用处于 Testing 时，Google 通常会让刷新令牌在 7 天后失效。""", flush=True)
    webbrowser.open(enable)
    if sys.platform != "darwin":
        path = input("请输入下载的桌面应用 JSON 完整路径，然后按回车：").strip().strip('"')
        if not path:
            raise RuntimeError("未选择客户端文件。")
        return Path(path).expanduser()
    input("完成 Cloud 配置、下载文件后按回车选择 JSON：")
    result = subprocess.run(["/usr/bin/osascript", "-e",
        'POSIX path of (choose file with prompt "选择 Google Cloud 下载的桌面应用 OAuth 客户端 JSON")'],
        capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError("已取消选择客户端文件。")
    return Path(result.stdout.strip())


def authorize(client_file, persist=True):
    cfg = json.loads(client_file.expanduser().read_text(encoding="utf-8-sig")).get("installed", {})
    return authorize_config(cfg, persist)


def authorize_config(cfg, persist=True):
    if not cfg.get("client_id", "").endswith(".apps.googleusercontent.com") or not cfg.get("client_secret"):
        raise ValueError("请选择 Google Cloud 下载的“桌面应用”客户端 JSON。")
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    state = secrets.token_urlsafe(32)
    received = {}

    class Callback(BaseHTTPRequestHandler):
        def do_GET(self):
            target = urlsplit(self.path)
            query = parse_qs(target.query)
            valid = target.path == "/" and hmac.compare_digest(query.get("state", [""])[0], state)
            if not valid:
                self.send_error(404)
                return
            received.update(query)
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write("Google 已返回授权结果，请回到并读发版窗口。".encode())

        def log_message(self, *_):
            pass  # 回调地址包含一次性授权码。

    with HTTPServer(("127.0.0.1", 0), Callback) as server:
        redirect = f"http://127.0.0.1:{server.server_port}/"
        params = dict(client_id=cfg["client_id"], redirect_uri=redirect, response_type="code",
                      scope=SCOPE, state=state, code_challenge=challenge, code_challenge_method="S256",
                      access_type="offline" if persist else "online", prompt="consent")
        url = "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(params)
        if not webbrowser.open(url):
            print("请在本机浏览器中打开以下 Google 授权链接：", url)
        server.timeout = 1
        deadline = time.monotonic() + 300
        while not received and time.monotonic() < deadline:
            server.handle_request()
    if not received.get("code"):
        raise RuntimeError("未取得 Google 授权（取消或超时）。可以重新双击。")
    client = {k: cfg[k] for k in ("client_id", "client_secret")}
    response = exchange(dict(client, grant_type="authorization_code", code=received["code"][0],
                             redirect_uri=redirect, code_verifier=verifier))
    if SCOPE not in response.get("scope", SCOPE).split() or not response.get("access_token"):
        raise RuntimeError("未取得 Chrome Web Store 的访问权限。")
    if persist:
        if not response.get("refresh_token"):
            raise RuntimeError("未取得可用于后续发版的商店离线授权。")
        keychain_write(dict(client, refresh_token=response["refresh_token"]))
    return response["access_token"]


def access_token(client_file=None, session_only=False):
    credentials = keychain_read() if client_file is None and not session_only else None
    if credentials:
        try:
            return exchange(dict(credentials, grant_type="refresh_token"))["access_token"]
        except PermissionError as error:
            print(error)
            # 复用已经配置的客户端，只需要用户再次登录授权。
            return authorize_config(credentials)
    return authorize(client_file or choose_client(), persist=not session_only)
