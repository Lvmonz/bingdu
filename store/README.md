# 并读发版

改完代码并通过测试后，从最新源码运行下表的入口。脚本查询并读原商店条目，选择版本、打包、上传并提交审核。Google 审核通过后按正常发布流程分发给已安装用户。商店条目 ID 是 `jilajlmefcnojfdchlablflkbdngopph`。[商店后台](https://chrome.google.com/webstore/devconsole/e3df8fd1-c30c-4b89-94f0-b7b721ad8f3b/jilajlmefcnojfdchlablflkbdngopph/edit/status)

| 系统 | 发版入口 | 准备一次 |
| --- | --- | --- |
| macOS | 在 Finder 双击 `store/一键发版.command` | 安装 Python 3.10 或更高版本。已在这台 Mac 授权过的用户可直接复用登录钥匙串。 |
| Windows | 在资源管理器双击 `store/release.cmd` | 安装 Python 3.10 或更高版本。在仓库根目录执行 `py -3 -m pip install -r store/requirements.txt`，用于访问 Windows 凭据管理器。如果电脑只有 `python` 命令，用它替换 `py -3`。 |
| Linux | 在仓库根目录运行 `./store/release.sh`，也可用支持在终端运行脚本的文件管理器打开它 | 准备 Python 3.10 或更高版本和已解锁的桌面 Secret Service 密钥环。在当前 Python 环境执行 `python3 -m pip install -r store/requirements.txt`。使用虚拟环境时先激活它。 |

## 第一次在新电脑上发版

1. 克隆仓库，在包含 `manifest.json` 的目录打开终端。先运行 `python3 -X utf8 store/release.py --authorize-only`，Windows 使用 `py -3 -X utf8 store/release.py --authorize-only`。
2. 在并读专用 Google Cloud 项目选择已启用的 Chrome Web Store API，准备类型为「桌面应用」的 OAuth 客户端 JSON。有现成文件时，可以给上面的命令追加 `--client "文件的完整路径"`。没有文件时，跟随终端的 Cloud 指引创建客户端并下载 JSON。首次设置测试应用时，在 Google Auth Platform 的 Audience 将商店发布账号列为测试用户。[Google 官方 API 设置](https://developer.chrome.com/docs/webstore/using-api)
3. 用有并读条目发布权限的 Google 账号登录浏览器并确认授权。浏览器回到本机后，终端会显示已验证原条目。凭据留在当前用户的系统凭据库，每台新电脑独立授权。客户端下载文件留在个人目录，只提交代码。Google 外部 OAuth 应用处于 Testing 状态时，商店授权的刷新令牌通常在七天后过期；工具会重新打开登录页。[Google 授权有效期](https://developers.google.com/identity/protocols/oauth2#expiration)
4. 用表中的发版入口提交。成功后在仓库中提交并推送脚本更新的 `manifest.json`，便于其他电脑检出相同版本。若本机没有可用的系统凭据库，可用 `python3 -X utf8 store/release.py --session-only --client "文件的完整路径"` 直接发版，每次都通过本机浏览器授权。

## 独立执行和核对

以下命令从仓库根目录运行，Windows 可用 `py -3` 替换 `python3`。

| 目的 | 命令 | 结果 |
| --- | --- | --- |
| 只打包 | `python3 -X utf8 store/package.py --output dist` | 按源码清单的版本在 `dist` 生成可安装的 ZIP，全程离线。 |
| 验证授权 | `python3 -X utf8 store/release.py --authorize-only` | 验证账号可以读取并读条目。 |
| 查询审核进展 | `python3 -X utf8 store/release.py --status` | 显示 Google 返回的已发布和已提交版本与状态。 |
| 自动升版、打包、上传和提审 | `python3 -X utf8 store/release.py` | 产物默认放在系统桌面；无桌面时使用仓库的 `dist`。可追加 `--output "目标目录"`。 |
| 测试发版工具 | `python3 -X utf8 -m unittest discover -s tests -p "test_release*.py"` | 在临时目录用模拟商店与模拟授权回调验证流程，全程使用测试数据。 |

脚本从商店返回的版本和本机上次版本选择基准，自动递增末位；如果源码版本已经更高，就沿用源码版本。若条目已有待审核或待发布版本，脚本显示状态并保留队列。上传过程断网时，用同一台电脑重新运行可恢复上次进度。更换源码路径后，只要该次打包内容一致，也能继续。请依次在不同电脑发版，Google 的上传和提交分两次请求，提交作用于条目上当时的草稿。[上传与提交 API](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items)

本机进度和发版备份 ZIP 在 macOS 的 `~/Library/Application Support/并读/商店发版`、Windows 的 `%LOCALAPPDATA%\Bingdu\ChromeWebStore`，以及 Linux 的 `$XDG_STATE_HOME/Bingdu/ChromeWebStore`（默认 `~/.local/state/Bingdu/ChromeWebStore`）。在新电脑发起发版时会重新查询商店。不同电脑的本地草稿进度各自保存。
