# 仪表盘指标参考

每个 UI 元素的完整说明——显示什么、数据来自哪里、如何计算。

[English](DASHBOARD.md) | [繁體中文](DASHBOARD.zh-TW.md)

---

## 数据流概览

```
Claude Code hooks
    │  POST /hook  (端口 7381)
    ▼
BuddyHub (hub.py)
    │  每次状态变化调用 build_heartbeat()
    ▼
WebSocket (端口 7382)
    │  每条消息是完整 JSON 快照
    ▼
useHub (React hook)  →  setHeartbeat(JSON.parse(msg))
    │  props 向下传递
    ▼
UI 组件

Claude Code statusline
    │  statusline.sh  (每隔几秒发送)
    │  POST /hook  (端口 7381)
    ▼
BuddyHub._on_statusline()
    │  写入 model / cost / context_window 各字段
    ▼
build_heartbeat()  →  WebSocket  →  UI 组件
```

每一帧心跳都是焦点会话的**完整快照**——不是增量。新心跳到达时，所有组件状态被整体替换。

---

## Header（顶栏）

```
CLAUDE BUDDY  ●  STARTED: 15:01 · 14m 50s · 1 SESSION · ACTIVE  ·  main
                                                                 [☀ ☾ 🖥]
```

| 元素 | hb 字段 | Hub 来源 | 前端计算 | 无数据 |
|------|---------|---------|---------|--------|
| 连接指示点 | *(WebSocket 状态)* | `ws.onopen` / `ws.onclose` | 绿色脉动 = 已连接；红色 = 断开 | 红点 |
| `STARTED: HH:MM` | `started_at` | `datetime.fromtimestamp(_sess_start[sid]).strftime("%H:%M")` | 原样显示 | 隐藏 |
| 实时计时器 | `started_ts` | `_sess_start[sid]`（Unix 秒）| `Date.now()/1000 − started_ts`，用 `formatDuration()` 格式化：`Xh Ym` / `Xm Ys` / `Xs`，每 1 秒 tick，`started_ts` 变化时重置 | 隐藏 |
| 会话数 | `total` | `len(effective)`，其中 `effective = 运行中 OR 停止 < 1800 秒内` 的会话 | `{total} SESSION` / `{total} SESSIONS` | — |
| 状态徽章 | `running` | `len(_sess_running)` | `running > 1` → `"{N} ACTIVE"`；`running == 1` → `"ACTIVE"`（绿）；`running == 0` → `"IDLE"`（灰） | `IDLE` |
| 分支徽章 | `branch` | `git rev-parse --abbrev-ref HEAD` 存到 `_sess_meta[sid]["branch"]` | 带 GitBranch 图标的边框徽章 | 隐藏 |

---

## Sidebar — 会话列表

每行对应 `hb.sessions` 的一个条目（最多 10 个，最新的在前）。

| 元素 | 字段 | Hub 来源 | 无数据 |
|------|------|---------|--------|
| 项目名 | `session.proj` | `os.path.basename(git_root)`，截断到 22 字符 | 回退到 `session.sid`（8 字符 ID 前缀）|
| 分支 + 脏文件数 | `session.branch`, `session.dirty` | `git rev-parse --abbrev-ref HEAD`；`git status --porcelain` 的行数 | 空则隐藏；`· N~` 仅在 `dirty > 0` 时追加 |
| 状态点 | `session.running`, `session.waiting` | `sid in _sess_running`；`sid in _sess_waiting`（PreToolUse 阻塞期间为 true）| 绿色脉动 = 运行中 · 黄色 = 等待审批 · 灰色 = 空闲 |
| 激活高亮 | `session.focused` | `sid == _resolve_focused()` | — |

**焦点解析优先级**（`_resolve_focused`）：
1. 用户手动点过某会话（`_focused_sid` 在 `_sess_total` 里）
2. 有活跃审批弹窗的会话
3. 最新启动的运行中会话
4. `_sess_meta` 里最近活动的会话

点击会话行发送 `{ cmd: "focus", sid: full_session_id }` 经 WebSocket；hub 设置 `_focused_sid` 并触发心跳。

---

## Stat Cards（统计卡片）

### Context Usage（上下文占用）

```
38%  / 200K
████████░░░░░░░░░░░
```

| 元素 | hb 字段 | Hub 来源 | 前端计算 | 无数据 |
|------|---------|---------|---------|--------|
| 百分比 | `context_pct`, `tokens`, `budget` | `context_pct`：来自 statusline `context_window.used_percentage`（0–100 整数，官方预算好的百分比）；`budget`：来自 statusline `context_window.context_window_size`（官方 context window 大小），fallback 为 `--budget` CLI 参数 | 优先直接使用 `context_pct`；若缺失则 fallback 为 `clamp(round(tokens / budget × 100), 0, 100)` | `0% / 200K` |
| 进度条 | 同上 | — | `width: {pct}%`，500 毫秒过渡 | 空条 |
| 颜色阈值 | — | — | `< 50%` → 主色；`50–69%` → 黄；`≥ 70%` → 红 + 发光 | — |
| 警告文案 | — | — | `≥ 50%` → "Warning: high usage"；`≥ 70%` → "Warning: near capacity" | 隐藏 |
| Budget 标签 | `budget` | 来自 statusline `context_window.context_window_size`，fallback 为 `--budget` 参数（默认 200 000）| `formatTokens(budget)` → 如 `200K`、`1.2M` | `200K` |

### Active Model（当前模型）

| 元素 | hb 字段 | Hub 来源 | 无数据 |
|------|---------|---------|--------|
| 模型名 | `model` | `model.display_name` 来自 statusline（如 `"Sonnet 4.6"`），存入 `_sess_model[sid]`；首次 statusline 到达前 fallback 为 transcript JSONL 解析 | `"—"` |
| 来源标签 | `source` | `SessionStart` hook 的 `source` 字段（如 `"startup"`、`"ide"`）| `"CLAUDE CODE"` |

### Cache Hit Rate（缓存命中率）

| 元素 | hb 字段 | Hub 来源 | 前端计算 | 无数据 |
|------|---------|---------|---------|--------|
| 百分比 | `cache_pct` | `int(cache_tokens × 100 / (input_tokens + cache_tokens))`；分母为 0 时为 0 | `round(cache_pct)` | `0%` |
| 进度条 | 同上 | — | `width: {pct}%` | 空条 |

**Token 累加规则** — 主要来源为 statusline payload（Claude Code 官方预计算，每隔几秒发送）：

- `input_tokens` = `context_window.total_input_tokens`（会话累计）
- `output_tokens` = `context_window.total_output_tokens`（会话累计）
- `cache_tokens` = `context_window.current_usage.cache_read_input_tokens`（最新一次调用，反映当前 prompt 在缓存里的大小，**不累加**）

Fallback（statusline 未到达前）：transcript JSONL 只用来提取 `model` 和 `assistant_msg`，**不用于** token 统计。

### Session Cost（会话成本）

| 元素 | hb 字段 | Hub 来源 | 前端计算 | 无数据 |
|------|---------|---------|---------|--------|
| 成本 | `cost_usd` | `cost.total_cost_usd` 来自 statusline — Claude Code 官方累计会话成本（USD），无需估算 | `$${cost.toFixed(2)}` | `$0.00` |
| Token 数 | `tokens` | `input_tokens + cache_tokens` | `formatTokens(tokens)` → 如 `76K` | `"No data"` |

---

## Metric Panels（指标面板）

### Token Distribution（Token 分布）

焦点会话的 Token 类型分解，三条横向进度条。

| 条 | hb 字段 | Hub 来源 | 条宽 |
|-----|---------|---------|------|
| INPUT | `input_tokens` | `context_window.total_input_tokens` 来自 statusline（会话累计）| `inp / total × 100%` |
| OUTPUT | `output_tokens` | `context_window.total_output_tokens` 来自 statusline（会话累计）| `out / total × 100%` |
| CACHE | `cache_tokens` | `context_window.current_usage.cache_read_input_tokens` 来自 statusline（最新调用，不累加）| `cache / total × 100%` |

`total = inp + out + cache`（最小 1 防止除零）。  
数值用 `formatTokens()` 格式化：`< 1 000` → 原值；`≥ 1 000` → `NNK`；`≥ 1 000 000` → `N.NM`。

无数据：三个字段全缺失 → 条全空，数值显示 `0`。

> **为什么 INPUT 看起来还是比 CACHE 小** — 长 session + prompt caching 可能显示 `INPUT = 40K` 对 `CACHE = 180K`。这是对的：CACHE 条是当前 prompt 大小，INPUT 条是 session 开始以来模型"真正新看到的"累计内容。

### Operator Approvals（操作员审批）

计数**按焦点 session**，切换到其他 session 会重置显示。

| 格子 | hb 字段 | Hub 来源 | 无数据 |
|------|---------|---------|--------|
| APPROVED | `approvals` | `_sess_approvals[sid]`，用户每点一次 Approve 就 +1 | `0` |
| DENIED | `denials` | `_sess_denials[sid]`，用户每点一次 Deny 或按 Escape 就 +1 | `0` |
| FAILED | `fail_count` | `_sess_fail_count[sid]`，每次 `PostToolUseFailure` hook 触发就 +1 | `0` |

### Code Changes（代码变更）

| 元素 | hb 字段 | Hub 来源 | 前端计算 | 无数据 |
|------|---------|---------|---------|--------|
| `+N` 插入 | `lines_added` | `cost.total_lines_added` 来自 statusline — Claude Code 官方统计的会话累计新增行数 | `+${added.toLocaleString()}` | `—` |
| `-N` 删除 | `lines_removed` | `cost.total_lines_removed` 来自 statusline — 会话累计删除行数 | `-${removed.toLocaleString()}` | `—` |
| 进度条 | 同上 | — | `peak = max(added, removed, 1)`；插入条 = `added/peak × 100%`；删除条 = `removed/peak × 100%`。较大值占满 100%，较小值按比例缩放。 | 两条全空 |

> `null`（字段缺失）和 `0`（零改动）显示不同：`null` 显示 `—`；`0` 显示 `+0` / `-0`。

> `_refresh_git` 仍然运行，但只获取 `branch`（分支名）和 `dirty`（脏文件数），这两个字段 statusline 不提供。

**工具调用次数**（条下方）：

| 元素 | hb 字段 | Hub 来源 |
|------|---------|---------|
| 工具名 + 次数 | `tool_counts` | 每次 `PostToolUse` hook 触发时 `_tool_counts[sid][tool_name]++` |

显示顺序：`Bash → Edit → Write → Read → Glob → Grep → WebFetch → WebSearch → Agent`，然后其他工具按字母序。全部显示（无上限）。`tool_counts` 缺失或为空时整块隐藏。

---

## Latest Response（最近回复）

焦点 session 最新一轮对话的终端风格面板。

```
┌─────────────────────────────────────────┐
│ ● ● ●  claude-code-buddy (main)         │
├─────────────────────────────────────────┤
│  YOU:                                   │
│  ▎ user question here...               │
│                                         │
│  sonnet 4.6:~$                          │
│                                         │
│  assistant reply here...                │
└─────────────────────────────────────────┘
```

| 元素 | hb 字段 | Hub 来源 | 无数据 |
|------|---------|---------|--------|
| 标题栏路径 | `project`, `branch` | `os.path.basename(git_root)` + `git rev-parse --abbrev-ref HEAD` | `"claude-code"` |
| 会话时间 | `started_at` | `datetime.fromtimestamp(_sess_start[sid]).strftime("%H:%M")` | 隐藏 |
| 提示符行 | `model` | `_short_model()` → 小写 + `:~$` | `claude:~$` |
| 用户问题 | `human_msg` | `_on_user_prompt` hook：`prompt` 字段，**保留换行**，智能 Markdown 截断（min 300 字符），存入 `_sess_human[sid]`；以 Markdown 格式渲染，显示在 "YOU:" 标签下方 | 隐藏（不渲染）|
| 助手回复 | `assistant_msg` | 主来源：`Stop` hook 的 `last_assistant_message`，智能 Markdown 截断（min 500 字符，max 1500）。备用：transcript JSONL 最后一条 `role=assistant`。存入 `_sess_assistant[sid]`；以 GitHub Flavoured Markdown 渲染 | `"Waiting for response…"` |

`assistant_msg` 和 `human_msg` 都**按 session 单独存**——切换到没有历史的 session 时这两个字段都会清空。

---

## Event Stream（事件流）

焦点 session 的 hook 事件按时间顺序展示。

```
Event Stream
│
●  15:03  Bash done
│
●  15:02  > fix the auth bug
│
●  15:01  session: claude-code-buddy
```

| 元素 | hb 字段 | Hub 来源 |
|------|---------|---------|
| 事件条目 | `entries` | `_sess_transcript[sid]`（每个 session 独立的 `deque(maxlen=20)`），每条 `"HH:MM {body[:80]}"` |
| 显示顺序 | — | 最新在前；最多显示 10 条；无计数徽章 |

**每个 hook 写入 transcript 的内容：**

| Hook | 条目文本 |
|------|---------|
| `SessionStart` | `session: {project}` 或 `session started` |
| `Stop` | `session done` |
| `UserPromptSubmit` | `> {prompt[:60]}` |
| `PreToolUse` (bypass) | `{tool} (bypass)` |
| `PreToolUse` approved | `{tool} allow` |
| `PreToolUse` denied | `{tool} deny` |
| `PreToolUse` timeout (30 秒) | `{tool} timeout` |
| `PreToolUse` 选中选项 | `{tool} → {label[:30]}` |
| `PostToolUse` | `{tool} done` |
| `PostToolUseFailure` | `{tool} FAIL: {error[:60]}` |
| `Notification` | `[notify] {message[:60]}` |

**颜色规则**（按正文内容）：

| 颜色 | 条件 |
|------|------|
| 红 | 含 `error`、`fail` 或 `denied` |
| 主色（金） | 含 `warn` 或 `approv` / `success` / `passed` |
| 绿 | 含 `approv`、`success`、`passed` |
| 主色/60 | 含 `tool`、`bash` 或 `read` |
| 灰 | 其他 |

条目**按 session 单独存**——切换 session 只显示该 session 自己的事件。

---

## Approval Modal（审批弹窗）

`PreToolUse` hook 阻塞 Claude Code 等待决定时显示的全屏遮罩。

```
┌─────────────────────────────────────────┐
│  Operator Approval Required             │
│  BASH                                   │
│  [abc12345]  my-project                 │
│                                         │
│  run the test suite                     │
│  ┌───────────────────────────────────┐  │
│  │ npm test                          │  │
│  └───────────────────────────────────┘  │
│                                         │
│  [✓ Approve]          [✗ Deny]          │
└─────────────────────────────────────────┘
```

| 元素 | hb 字段 | Hub 来源 |
|------|---------|---------|
| 工具名 | `prompt.tool` | hook payload 的 `tool_name`，截断到 19 字符 |
| 提示文字 | `prompt.hint` | `_hint()`：`Bash` → `command`；`Read/Edit/Write` → `file_path`；`WebFetch` → `url`；`WebSearch` → `query`。截断到 43 字符 |
| 正文（代码块） | `prompt.body` | `_body()`：按工具拼接细节——Bash 显示 description + command；Edit 显示 old/new 差异；Write 显示路径 + 前 320 字符内容。截断到 500 字符 |
| Session 徽章 | `prompt.sid` | `session_id[:8]` |
| 项目徽章 | `prompt.project` | `_sess_meta[sid]["project"]`，截断到 23 字符 |
| 选项（AskUserQuestion）| `prompt.options` | question payload 的选项标签，最多 4 个 |

**决策流：**

| 动作 | WebSocket 命令 | Hub 响应 |
|------|---------------|---------|
| 点 Approve | `{ cmd: "approve", id }` | `permissionDecision: "allow"` |
| 点 Deny / Escape | `{ cmd: "deny", id }` | `permissionDecision: "deny"` |
| 点选项按钮 | `{ cmd: "option", id, index }` | `permissionDecision: "deny"`，reason 里带所选标签（Claude 读 reason 获取答案）|
| 30 秒无操作 | *(超时)* | `permissionDecision: "deny"`，理由 "buddy hub: no user decision within 30s"——显式 fail-closed，避免漏看的请求被默认放行 |

多个并发审批请求会排队；每次决定后弹窗自动推进到下一个。

---

## Mobile Bottom Navigation（移动端底部导航）

窄于 `md`（768 px）的屏幕上显示。只有一个 **Sessions** 按钮，切换左侧抽屉覆盖主内容。抽屉里是和桌面侧边栏一样的会话列表；点会话行会 focus 并关闭抽屉。点遮罩也可关闭抽屉。
