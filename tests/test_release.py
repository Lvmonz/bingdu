"""Cross-platform release tests. All credentials and store calls are simulated."""
import hashlib
import io
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import urlopen
from zipfile import ZipFile

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / "store"))
import package
import release
import release_platform
import store_auth


def revision(version, state):
    return {"state": state, "distributionChannels": [{"crxVersion": version}]}


class FakeStore:
    def __init__(self):
        self.remote = {"publishedItemRevisionStatus": revision("0.4.8", "PUBLISHED")}
        self.calls = []
        self.incoming = None
        self.processing = False

    def status(self):
        return self.remote

    def call(self, method, payload):
        self.calls.append(method)
        if method == "upload":
            with ZipFile(io.BytesIO(payload)) as archive:
                self.incoming = json.loads(archive.read("manifest.json"))["version"]
            if self.processing:
                return {"uploadState": "IN_PROGRESS"}
            return {"uploadState": "SUCCEEDED", "crxVersion": self.incoming}
        if method != "publish" or json.loads(payload) != {"publishType": "DEFAULT_PUBLISH"}:
            raise AssertionError("Unexpected release operation")
        self.remote["submittedItemRevisionStatus"] = revision(self.incoming, "PENDING_REVIEW")
        return {"state": "PENDING_REVIEW"}


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.root = self.tmp / "Checkout 并读"
        self.state = self.tmp / "private-state"
        self.output = self.tmp / "out" / "安装包"
        with ZipFile(package.build(PROJECT, self.tmp / "fixture-zip")) as source:
            source.extractall(self.root)
        manifest_path = self.root / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["version"] = "0.4.4"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False) + "\n", encoding="utf-8")
        self.store = FakeStore()

    def invoke(self, flags=()):
        with patch.object(release, "ROOT", self.root), patch.object(
                release, "state_directory", return_value=self.state), patch.object(
                release, "access_token", return_value="test-only") as auth, patch.object(
                release, "Store", return_value=self.store), redirect_stdout(io.StringIO()) as output:
            release.main(["--output", str(self.output), *flags])
        return output.getvalue(), auth

    def test_clean_computer_uses_remote_version_and_submits_once(self):
        self.invoke()
        self.assertEqual(self.store.calls, ["upload", "publish"])
        self.assertEqual(self.store.incoming, "0.4.9")
        archive = self.output / "并读-0.4.9-Chrome商店.zip"
        self.assertTrue(archive.is_file())
        manifest = json.loads((self.root / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["version"], "0.4.9")
        journal = json.loads((self.state / "release.json").read_text(encoding="utf-8"))
        self.assertEqual(journal["sha256"], hashlib.sha256(archive.read_bytes()).hexdigest())
        self.assertEqual(journal["phase"], "done")
        self.invoke()
        self.assertEqual(self.store.calls, ["upload", "publish"])
        # Another computer, with a separate release journal, sees the active review.
        self.state = self.tmp / "new-user"
        self.invoke()
        self.assertEqual(self.store.calls, ["upload", "publish"])

    def test_read_only_operations_never_publish_or_update_source(self):
        original = (self.root / "manifest.json").read_bytes()
        _, auth = self.invoke(["--authorize-only", "--client", "example.json"])
        auth.assert_called_once_with(Path("example.json"), False)
        output, auth = self.invoke(["--status", "--session-only"])
        auth.assert_called_once_with(None, True)
        self.assertIn("0.4.8", output)
        self.assertEqual(self.store.calls, [])
        self.assertEqual(original, (self.root / "manifest.json").read_bytes())
        self.assertFalse(self.output.exists())
        self.assertFalse((self.state / "release.json").exists())

    def test_interrupted_upload_continues_from_equivalent_moved_checkout(self):
        self.store.processing = True
        self.store.remote["lastAsyncUploadState"] = "IN_PROGRESS"
        with patch.object(release.time, "sleep", side_effect=InterruptedError), self.assertRaises(InterruptedError):
            self.invoke()
        self.assertEqual(self.store.calls, ["upload"])
        new_root = self.tmp / "renamed 源码"
        self.root.rename(new_root)
        self.root = new_root
        self.store.remote["lastAsyncUploadState"] = "SUCCEEDED"
        self.invoke()
        self.assertEqual(self.store.calls, ["upload", "publish"])

    def test_publish_error_after_acceptance_recovers_via_status(self):
        send = self.store.call

        def lose_publish_response(method, payload):
            result = send(method, payload)
            if method == "publish":
                raise ConnectionResetError
            return result

        with patch.object(self.store, "call", side_effect=lose_publish_response), self.assertRaises(ConnectionResetError):
            self.invoke()
        self.invoke()
        self.assertEqual(self.store.calls, ["upload", "publish"])
        journal = json.loads((self.state / "release.json").read_text(encoding="utf-8"))
        self.assertEqual(journal["phase"], "done")

    def test_duplicate_version_does_not_publish_unidentified_draft(self):
        with patch.object(self.store, "call", side_effect=release.StoreError(409, "Version already exists")), self.assertRaisesRegex(RuntimeError, "409"):
            self.invoke()
        self.invoke()
        self.assertEqual(self.store.incoming, "0.4.10")
        self.assertEqual(self.store.calls, ["upload", "publish"])

    def test_lock_blocks_second_process_and_releases(self):
        child = "from release_platform import release_lock; from pathlib import Path; import sys\nwith release_lock(Path(sys.argv[1])): pass"
        args = [sys.executable, "-X", "utf8", "-c", child, str(self.state)]
        with release_platform.release_lock(self.state):
            blocked = subprocess.run(args, cwd=PROJECT / "store", capture_output=True)
            self.assertNotEqual(blocked.returncode, 0)
            self.assertIn("另一个并读".encode(), blocked.stderr)
        self.assertEqual(subprocess.run(args, cwd=PROJECT / "store", capture_output=True).returncode, 0)

    def test_package_artifact_contains_only_runtime_and_is_repeatable(self):
        output = package.build(self.root, self.output)
        first = output.read_bytes()
        rebuilt = package.build(self.root, self.tmp / "other").read_bytes()
        self.assertEqual(first, rebuilt)
        with ZipFile(output) as archive:
            self.assertIn("manifest.json", archive.namelist())
            self.assertFalse(any(path.startswith(("store/", "tests/")) for path in archive.namelist()))
            self.assertTrue(all(info.create_system == 3 for info in archive.infolist()))


class LoginTests(unittest.TestCase):
    def test_first_login_pkce_and_loopback(self):
        for persist in (True, False):
            with self.subTest(persist=persist), tempfile.TemporaryDirectory() as tmp:
                client = {"client_id": "unit-test.apps.googleusercontent.com", "client_secret": "unit-test"}
                path = Path(tmp) / "测试客户端.json"
                path.write_text(json.dumps({"installed": client}), encoding="utf-8-sig")
                seen = {}
                threads = []

                def open_browser(url):
                    seen.update(parse_qs(urlsplit(url).query))
                    redirect = seen["redirect_uri"][0]
                    def callback():
                        with urlopen(redirect + "?" + urlencode({"state": seen["state"][0], "code": "test-code"}), timeout=5):
                            pass
                    threads.append(threading.Thread(target=callback))
                    threads[-1].start()
                    return True

                def exchange(form):
                    import base64
                    challenge = base64.urlsafe_b64encode(hashlib.sha256(form["code_verifier"].encode()).digest()).decode().rstrip("=")
                    self.assertEqual(seen["code_challenge"], [challenge])
                    self.assertEqual(seen["scope"], [store_auth.SCOPE])
                    self.assertEqual(seen["access_type"], ["offline" if persist else "online"])
                    self.assertEqual(form["code"], "test-code")
                    self.assertEqual(form["redirect_uri"], seen["redirect_uri"][0])
                    return {"access_token": "test-access", **({"refresh_token": "test-refresh"} if persist else {})}

                with patch.object(store_auth.webbrowser, "open", side_effect=open_browser), patch.object(
                        store_auth, "exchange", side_effect=exchange), patch.object(store_auth, "keychain_write") as write, patch.object(
                        store_auth, "keychain_read", side_effect=AssertionError("unexpected keychain access")):
                    self.assertEqual(store_auth.access_token(path, session_only=not persist), "test-access")
                for thread in threads:
                    thread.join()
                if persist:
                    write.assert_called_once_with(dict(client, refresh_token="test-refresh"))
                else:
                    write.assert_not_called()

    def test_portable_vault_preserves_current_item_and_renews_authorization(self):
        credentials = {"client_id": "old", "client_secret": "test", "refresh_token": "test"}
        for platform in ("win32", "linux"):
            vault = Mock()
            vault.get_password.return_value = json.dumps(credentials)
            with self.subTest(platform=platform), patch.object(store_auth.sys, "platform", platform), patch.object(
                    store_auth, "system_vault", return_value=vault), patch.object(
                    store_auth, "exchange", return_value={"access_token": "ok"}) as exchange:
                self.assertEqual(store_auth.access_token(), "ok")
                exchange.assert_called_once_with(dict(credentials, grant_type="refresh_token"))
                vault.get_password.assert_called_once_with(store_auth.SERVICE, release.ITEM)
                store_auth.keychain_write(credentials)
                self.assertEqual(json.loads(vault.set_password.call_args.args[2]), credentials)

    def test_mac_reuses_original_keychain_record(self):
        import base64
        credentials = {"client_id": "existing-client", "client_secret": "test", "refresh_token": "simulated"}
        ok = Mock(returncode=0, stdout=base64.urlsafe_b64encode(json.dumps(credentials).encode()))
        with patch.object(store_auth.sys, "platform", "darwin"), patch.object(store_auth.subprocess, "run", return_value=ok) as security:
            self.assertEqual(store_auth.keychain_read(), credentials)
        self.assertEqual(security.call_args.args[0], ["/usr/bin/security", "find-generic-password", "-s",
                                                     "Bingdu.ChromeWebStore.OAuth", "-a", release.ITEM, "-w"])
