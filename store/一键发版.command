#!/bin/zsh
cd "${0:A:h}" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
echo "并读 · Chrome 商店发版"
echo "本次源码目录：${PWD:h}"
python3 -X utf8 ./release.py "$@"
result=$?
if [[ -t 0 ]]; then
  read -r "?按回车关闭窗口。"
fi
exit "$result"
