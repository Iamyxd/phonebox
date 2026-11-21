# Antigravity Webhook Bridge

将本地 Antigravity 的实时模型配额与会话遥测（通过开启 CDP 调试端口的窗口内 `window.__AGUnifiedTelemetry`）定期推送到本机 PhoneBox Agent（`http://127.0.0.1:8765/api/push/<key>`），直接填充手机端的 **AI quotas**（`ai`）和 **Sessions**（`work`）页面。

## 用法

```sh
bash tools/antigravity-bridge/start.sh setup   # 配置 PhoneBox 的 AI quotas 与 Sessions 页面展示 Antigravity 数据
bash tools/antigravity-bridge/start.sh         # 后台启动 PhoneBoxAgent 与同步服务（默认）
bash tools/antigravity-bridge/start.sh status  # 查看桌面代理、手机连接与同步进程状态
bash tools/antigravity-bridge/start.sh stop    # 停止同步服务与 PhoneBoxAgent
bash tools/antigravity-bridge/start.sh fg      # 前台运行同步并实时打印日志
bash tools/antigravity-bridge/start.sh once    # 单次同步并打印摘要
bash tools/antigravity-bridge/start.sh open    # 在浏览器打开设置页面
```

## 依赖条件

- 本机需运行带 `--remote-debugging-port` 的 Antigravity，且窗口中已注入 `window.__AGUnifiedTelemetry`（例如通过 `antigravity-usage-suite`）。
- 运行时优先使用系统 `node >= 22`，若未安装则自动回退到本机 `Antigravity` 可执行文件（`ELECTRON_RUN_AS_NODE=1`）。
