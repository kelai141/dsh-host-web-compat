# dsh-host-web-compat

宿主插件：通过 `webServer.tapIndex` 钩子在每个 index.html 响应注入旧内核缺失的浏览器 API polyfill。

## 背景（M0 实测）

MuMu 自带浏览器（com.kunmobile.kun_mobile）与部分老 WebView 内核缺少 `AbortSignal.any()`，
导致 dsh 的「选择工作区 → 目录浏览器」的 RPC 并发取消直接抛 `AbortSignal.any is not a function`，
目录列表渲染为空——工作区选择看起来"跑不通"。

注入 polyfill 后目录浏览器完整恢复（已验证：列目录、显示隐藏文件、打开工作区、新会话可用）。

## 挂载方式

- 作为 bundle（推荐）：并入 `dsh-android` bundle 的 `cordis.patch.yml`（见 cordis.patch.yml 示例）；
- 或作为 profile 插件：`dsh plugin --profile web install @dsh-android/dsh-host-web-compat`；
- 或手动：放入 profile node_modules + profile 的 cordis.patch.yml 插入行。

## 后续增强

- 按需追加更多 polyfill（structuredClone 已含；可按目标内核清单扩充）；
- 壳 APK 形态下系统 WebView 可更新，此插件可保留作为"最后一公里"兜底；
- 若走 Android 原生 SAF picker（壳 APK JS 桥），本插件仍建议保留——页面其他功能同样受益。
