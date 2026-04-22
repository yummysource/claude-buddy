# claude-code-buddy

用于监控 Claude Code 会话的实时仪表盘和可选硬件显示设备。Claude Code hook 把事件 POST 到本机 Python hub，hub 通过 WebSocket 把完整心跳快照推送到 Next.js Web UI（可选同时推送到串口或 BLE 硬件设备）。界面允许远程批准或拒绝工具调用，手机在同一局域网时同样可用。

[English](README.md) | [繁體中文](README.zh-TW.md)

## 功能亮点

- **实时会话监控** — 状态、模型、上下文占用率随每次 hook 更新。
- **远程审批 UI** — 在浏览器（桌面/手机）批准或拒绝 `PreToolUse` 请求。
- **多会话支持** — 多个并发 Claude Code 会话共享同一仪表盘，侧边栏最多显示 5 个。
- **Token 用量与成本追踪** — 按输入/输出/缓存拆分，按模型定价计算美元成本。
- **按会话记录 Git 状态** — 当前分支、脏文件数、已提交与未提交行数差。
- **事件流时间线** — 当前会话的 hook 事件按时间排列并按类型着色。
- **可选硬件显示** — 同一份心跳可推送到串口或 Nordic UART BLE 设备。

## 架构

```
  Claude Code                Python hub                   Next.js 前端
  (hooks)                    (BuddyHub)                   (Bun dev server)
  ──────────                 ──────────                   ────────────────
       │                          │                             │
       │  POST /hook              │                             │
       │  127.0.0.1:7381          │                             │
       ├─────────────────────────▶│                             │
       │                          │  WebSocket                  │
       │                          │  :7382                      │
       │                          ├────────────────────────────▶│  ◀── 浏览器
       │                          │                             │      (桌面 / 同局域网的手机)
       │                          │  串口 / BLE (可选)           │
       │                          ├──▶  硬件显示                  │
```

每一帧心跳是当前焦点会话的完整 JSON 快照——完整字段来源说明见 [DASHBOARD.zh-CN.md](DASHBOARD.zh-CN.md)。

## 先决条件

- Python 3.11 或更新版本，并已安装 [`uv`](https://docs.astral.sh/uv/)。
- [Bun](https://bun.sh) 1.x，或 Node.js 20 或更新版本。
- Claude Code 已安装且可从命令行运行。

## 安装

```bash
git clone https://github.com/<your-fork>/claude-code-buddy.git
cd claude-code-buddy/server/python && uv sync
cd ../../web && bun install
```

## 接入 Claude Code hook

把 [`hooks/settings.json`](hooks/settings.json) 中的 `hooks` 块合并到 `~/.claude/settings.json`。

每个 hook 把 Claude Code 的事件 POST 到 `http://127.0.0.1:7381/hook`。命令末尾的 `|| echo '{}'` 保证 hub 离线时 Claude Code 仍可正常运行——curl 失败时会给 hook runner 返回空 JSON 对象，而不是阻塞会话。

## 启动

| 场景           | hub 命令                                                  | 前端命令           | 访问 URL                        |
|----------------|-----------------------------------------------------------|---------------------|---------------------------------|
| 仅本机         | `uv run python -m hub`                                    | `bun run dev`       | `http://localhost:3000`         |
| 局域网 + token | `uv run python -m hub --host 0.0.0.0`                     | `bun run dev`       | 从 hub banner 复制 URL          |
| 局域网无鉴权   | `uv run python -m hub --host 0.0.0.0 --no-auth`           | `bun run dev`       | `http://<LAN-IP>:3000`          |

hub 从 `server/python/` 启动，前端从 `web/` 启动。hub 在 stderr 打印可直接复制的访问信息，例如：

```
  Access:
    http://localhost:3000?token=abc…
    http://192.168.1.42:3000?token=abc…

  WebSocket token: abc…
  (stored at /Users/you/.config/claude-buddy/token)
```

Token 持久化到 `~/.config/claude-buddy/token`，权限 `0600`，所以重启 hub 后手机书签仍然有效。要轮换 token：启动时加不带值的 `--token`（自动生成新 token 并覆盖文件）；或用 `--token VALUE` 只在本次启动使用 VALUE（不改文件）。

## 从手机访问

1. 在电脑上运行：`uv run python -m hub --host 0.0.0.0`
2. 让手机和电脑连到同一 Wi-Fi。
3. 从 hub banner 中复制一条 `http://<LAN-IP>:3000?token=…` 形式的 URL，粘贴到手机浏览器打开。

如果界面顶部显示红色 **Unauthorized** 横幅，说明 URL 里的 token 与 hub 不匹配——重新从 banner 复制完整 URL 即可。

## CLI 参数

| 参数             | 默认值        | 说明                                                                                          |
|------------------|---------------|-----------------------------------------------------------------------------------------------|
| `--host`         | `127.0.0.1`   | WebSocket 绑定地址。`0.0.0.0` 把 hub 暴露到局域网，此时需要 token（除非同时指定 `--no-auth`）。|
| `--port`         | `7381`        | HTTP hook 监听端口。无论 `--host` 取什么值，始终绑定在 `127.0.0.1`。                            |
| `--ws-port`      | `7382`        | WebSocket 推送端口。                                                                           |
| `--token`        | _(自动生成)_  | 不带值的 `--token` 轮换持久化 token；`--token VALUE` 只在本次启动使用 VALUE 不改文件。loopback 绑定时忽略。 |
| `--no-auth`      | 关闭          | 即便在 LAN 绑定下也不启用 token 鉴权。仅在可信网络使用。                                       |
| `--budget`       | `200000`      | 上下文 token 预算，用于进度条。`0` 隐藏进度条。                                                |
| `--owner`        | `$USER`       | 仪表盘顶部显示的 owner 名称。                                                                  |
| `--transport`    | `auto`        | 硬件 transport：`auto` / `serial` / `ble` / `none`。                                          |
| `--serial-port`  | _(无)_        | 显式串口设备路径；会覆盖 `--transport`。                                                        |

## 仪表盘概览

整个 UI 由每次更新一份 JSON 心跳驱动。主要组件：

- **Header（顶栏）** — 连接指示点、会话开始时间、实时计时器、会话数、状态徽章、当前分支。来源：`started_at`、`started_ts`、`running`、`branch`。
- **Sidebar（侧边栏）** — 最多 5 个会话，每条展示项目名、分支、脏文件数、状态点。点击切换焦点。来源：`hb.sessions[]`。
- **Stat cards（统计卡片）** — 上下文占用（`tokens`/`budget`）、当前模型（`model`、`source`）、缓存命中率（`cache_pct`）、会话成本（`cost_usd`、`tokens`）。
- **Metric panels（指标面板）** — Token 分布（`input_tokens`/`output_tokens`/`cache_tokens`）、审批统计（`approvals`、`denials`、`fail_count`）、代码变更（`lines_added`、`lines_removed`、`tool_counts`）。
- **Latest Response（最近回复）** — 终端风格面板，展示焦点会话的用户问题（`human_msg`）和助手回答（`assistant_msg`）。
- **Event Stream（事件流）** — 焦点会话的 hook 事件时间线（`entries`）。
- **Approval Modal（审批弹窗）** — `PreToolUse` hook 等待决定时的全屏遮罩。按钮通过同一个 WebSocket 发送 `{cmd: "approve" | "deny" | "option", id}`。

每个指标的完整来源与计算方式详见 [DASHBOARD.zh-CN.md](DASHBOARD.zh-CN.md)——包含每个字段的 hub 来源以及前端的展示逻辑。

## 故障排除

- **Next.js 报 "Blocked cross-origin request to Next.js dev resource"** — `next.config.ts` 启动时自动收集所有非内网 IPv4。换 Wi-Fi 或 IP 变化后，需要重启 `bun run dev` 重新读取网卡。
- **Chrome 对 LAN IP 强制跳 HTTPS（`ERR_SSL_PROTOCOL_ERROR`）** — 地址栏显式输入 `http://` 前缀；或者打开 `chrome://net-internals/#hsts`，在 **Delete domain security policies** 下输入 IP 清除记录。
- **手机显示 "Disconnected"** — 查看横幅上显示的 WebSocket URL，确认它指向你的 LAN IP 而不是 `localhost`。直接从 banner 复制 URL，而不要手动输入。
- **重启 hub 后 token 没变** — 这是刻意的。启动时加不带值的 `--token` 即可轮换；或手动删除 `~/.config/claude-buddy/token`。

## 开发

```bash
# Python hub — 每次改完都跑一下语法检查
cd server/python
uv run python -m py_compile hub/*.py

# 前端
cd web
bun run build
```

完整编码规则见 [AGENTS.md](AGENTS.md)，Claude Code 相关细节见 [CLAUDE.md](CLAUDE.md)。

## 许可协议

MIT
