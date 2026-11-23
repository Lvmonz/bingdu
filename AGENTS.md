# 并读维护约定

- Chrome 直接加载根目录的 manifest.json。页面文字和视频字幕各有开关；改动页面遍历时同时检查 YouTube 播放器、换页、还原和滚动加载。模块分工见 [组件与数据流](docs/architecture.md)。
- 在常规 Chrome 或隔离浏览器加载本目录进行开发。测试和打包入口见 [README](README.md)。测试应使用临时配置和模拟翻译响应。
- 运行文件新增依赖时核对 store/package.py 的打包清单。保留 vendor/ 下原有许可。
- 发布到 GitHub 前检查 Git 跟踪内容。翻译密钥、桌面 OAuth JSON、令牌、开发者后台截图和个人浏览器采样保存在电脑上。
- 提交代码后通过 PR 运行检查。运行 store/release.py 的默认模式会向原商店条目上传并提审，只有明确要求商店发版时才执行。
