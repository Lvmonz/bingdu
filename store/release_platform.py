"""Resolve per-user release locations and serialize releases on the same computer."""
import errno
import os
import sys
from contextlib import contextmanager
from pathlib import Path


def state_directory():
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library/Application Support/并读/商店发版"
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or home / "AppData/Local")
    else:
        base = Path(os.environ.get("XDG_STATE_HOME") or home / ".local/state")
    return base / "Bingdu" / "ChromeWebStore"


def output_directory(root):
    home = Path.home()
    desktop = home / "Desktop"
    if os.name == "nt":
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders") as key:
                desktop = Path(os.path.expandvars(winreg.QueryValueEx(key, "Desktop")[0]))
        except OSError:
            pass
    elif sys.platform.startswith("linux"):
        config = Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config") / "user-dirs.dirs"
        if config.is_file():
            for line in config.read_text(encoding="utf-8").splitlines():
                if line.startswith("XDG_DESKTOP_DIR="):
                    value = line.split("=", 1)[1].strip().strip('"')
                    if value.startswith("$HOME/"):
                        desktop = home / value[6:]
                    elif Path(value).is_absolute():
                        desktop = Path(value)
                    break
    return desktop if desktop.is_dir() else root / "dist"


@contextmanager
def release_lock(directory):
    directory.mkdir(mode=0o700, exist_ok=True, parents=True)
    with (directory / "release.lock").open("a+b") as lock:
        try:
            if os.name == "nt":
                import msvcrt
                if not lock.tell():
                    lock.write(b"0")
                    lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            if error.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                raise RuntimeError("另一个并读发版窗口正在运行。") from None
            raise
        # Closing the descriptor releases either native lock, including on process exit.
        yield
