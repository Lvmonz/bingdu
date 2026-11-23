"""Check files selected for the public repository, without printing matched content."""
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
SENSITIVE = re.compile(
    rb"sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}"
    rb"|-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----|AIza[0-9A-Za-z_-]{35}"
    rb"|GOCSPX-[A-Za-z0-9_-]{18,}|1//[A-Za-z0-9_-]{50,}"
)
PRIVATE_NAME = re.compile(
    r"(?:^|/)(?:analysis/|node_modules/|\.env(?:\.|$)|client_secret[^/]*\.json|"
    r"credentials\.json|release\.json|token\.json)|\.(?:zip|pem|key|bak)$", re.I
)


def main():
    paths = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).split(b"\0")
    problems = []
    for encoded in filter(None, paths):
        name = encoded.decode("utf-8")
        data = (ROOT / name).read_bytes()
        if PRIVATE_NAME.search(name) or SENSITIVE.search(data):
            problems.append(name)
        elif not name.endswith(".png") and re.search(rb"(?:/Users/|[A-Z]:\\Users\\)[\w.\-]+[/\\]", data):
            problems.append(name)
    if problems:
        sys.exit("请检查以下文件的公开内容或本机路径名：\n" + "\n".join(problems))
    print("已检查 Git 跟踪文件。")


if __name__ == "__main__":
    main()
