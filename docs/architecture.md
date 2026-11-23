# 组件与数据流

| 使用入口 | 代码 | 处理过程 |
| --- | --- | --- |
| 点击浮球、工具栏或快捷键 | `popup.html`、`panel.js`、`reading-controls.js`、`page-access.js`、`worker.js` | 确定当前标签页和操作。浏览器负责本地文件访问授权。 |
| 阅读网页 | `page.js`、`page.css` | 找出可阅读单元，随阅读位置分批翻译。切换模式或恢复时处理对应的原始 DOM 节点。 |
| 观看 YouTube | `youtube-caption-source.js`、`youtube-caption-track.js`、`youtube-captions.js` | 从播放器读取字幕轨或已出现的字幕，按时间渲染在并读字幕框内。页面正文与字幕可分别开关。 |
| 设置和模型请求 | `panel.html`、`panel.js`、`worker.js` | 浏览器本地存储保存密钥、目标语言、术语和偏好。后台按需把待译文字或图片发送到 DeepSeek。 |
| 导出本地文档 | `files.js`、`pdf-export.js`、`epub-export.js`、`vendor/` | 本地解析和组成导出文件。扫描 PDF 的页面识别会向 DeepSeek 提交相应页面图像。 |
| 提交商店更新 | `store/package.py`、`store/release.py`、`store/store_auth.py`、`store/release_platform.py` | 按运行文件清单制包；发版工具从原条目读取版本，记录本次进度，用维护者在本机授予的权限上传和提审。 |

## 服务、凭据和运行边界

- 翻译接口是 `https://api.deepseek.com/chat/completions`，模型配置在 `worker.js`。扫描识别接口是 `https://api.deepseek.com/v1/tools/ocr`。阅读者向 DeepSeek 获取并管理自己的密钥，在并读设置里保存。用量和费用取决于该账号和服务商的计费规则。
- 网页的阅读偏好按站点或本地文件保存，字幕和网页翻译在浏览器中显示。隐私政策列出实际处理的数据种类和接收方。[隐私政策](../store/隐私政策.md)
- 商店 API 使用专用 Google Cloud 项目的桌面客户端。新电脑需要维护者持有客户端配置、登录有原条目权限的账号并授权。持久授权使用系统凭据库，ZIP 和中断续传记录由当地操作系统的用户目录保存。审核和商店分发由 Google 管理。[Google 官方发布接口](https://developer.chrome.com/docs/webstore/using-api)
- GitHub Actions 使用本地测试页面和模拟服务测试并生成包。只有维护者显式运行发版入口才会访问商店提交更新。
