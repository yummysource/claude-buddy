# 儀表板指標參考

每個 UI 元素的完整說明——顯示什麼、資料來自哪裡、如何計算。

[English](DASHBOARD.md) | [简体中文](DASHBOARD.zh-CN.md)

---

## 資料流概觀

```
Claude Code hooks
    │  POST /hook  (埠 7381)
    ▼
BuddyHub (hub.py)
    │  每次狀態變化呼叫 build_heartbeat()
    ▼
WebSocket (埠 7382)
    │  每則訊息是完整 JSON 快照
    ▼
useHub (React hook)  →  setHeartbeat(JSON.parse(msg))
    │  props 向下傳遞
    ▼
UI 元件
```

**第二條通道 — Statusline：**

```
Claude Code statusline 機制
    │  每隔幾秒發送 payload 給 statusline.sh
    ▼
statusline.sh
    │  POST /hook  (埠 7381，帶 statusline payload)
    ▼
BuddyHub._on_statusline()
    │  寫入 model、cost、context_window 各欄位
    ▼
WebSocket (埠 7382)  →  UI 元件
```

每一幀心跳都是焦點工作階段的**完整快照**——不是增量。新心跳到達時，所有元件狀態會被整體替換。

---

## Header（頂列）

```
CLAUDE BUDDY  ●  STARTED: 15:01 · 14m 50s · 1 SESSION · ACTIVE  ·  main
                                                                 [☀ ☾ 🖥]
```

| 元素 | hb 欄位 | Hub 來源 | 前端計算 | 無資料 |
|------|---------|---------|---------|--------|
| 連線指示點 | *(WebSocket 狀態)* | `ws.onopen` / `ws.onclose` | 綠色脈動 = 已連線；紅色 = 斷線 | 紅點 |
| `STARTED: HH:MM` | `started_at` | `datetime.fromtimestamp(_sess_start[sid]).strftime("%H:%M")` | 原樣顯示 | 隱藏 |
| 即時計時器 | `started_ts` | `_sess_start[sid]`（Unix 秒）| `Date.now()/1000 − started_ts`，用 `formatDuration()` 格式化：`Xh Ym` / `Xm Ys` / `Xs`，每 1 秒 tick，`started_ts` 變動時重置 | 隱藏 |
| 工作階段數 | `total` | `len(effective)`，其中 `effective = 執行中 OR 停止 < 1800 秒內` 的工作階段 | `{total} SESSION` / `{total} SESSIONS` | — |
| 狀態徽章 | `running` | `len(_sess_running)` | `running > 1` → `"{N} ACTIVE"`；`running == 1` → `"ACTIVE"`（綠）；`running == 0` → `"IDLE"`（灰）| `IDLE` |
| 分支徽章 | `branch` | `git rev-parse --abbrev-ref HEAD` 存到 `_sess_meta[sid]["branch"]` | 帶 GitBranch 圖示的邊框徽章 | 隱藏 |

---

## Sidebar — 工作階段清單

每列對應 `hb.sessions` 的一個條目（最多 10 個，最新的在前）。

| 元素 | 欄位 | Hub 來源 | 無資料 |
|------|------|---------|--------|
| 專案名 | `session.proj` | `os.path.basename(git_root)`，截斷到 22 字元 | 回退到 `session.sid`（8 字元 ID 前綴）|
| 分支 + 髒檔案數 | `session.branch`, `session.dirty` | `git rev-parse --abbrev-ref HEAD`；`git status --porcelain` 的行數 | 空則隱藏；`· N~` 僅在 `dirty > 0` 時附加 |
| 狀態點 | `session.running`, `session.waiting` | `sid in _sess_running`；`sid in _sess_waiting`（PreToolUse 阻塞期間為 true）| 綠色脈動 = 執行中 · 黃色 = 等待審批 · 灰色 = 閒置 |
| 啟用高亮 | `session.focused` | `sid == _resolve_focused()` | — |

**焦點解析優先級**（`_resolve_focused`）：
1. 使用者手動點過某工作階段（`_focused_sid` 在 `_sess_total` 裡）
2. 有活躍審批彈窗的工作階段
3. 最新啟動的執行中工作階段
4. `_sess_meta` 裡最近活動的工作階段

點擊工作階段列會透過 WebSocket 送出 `{ cmd: "focus", sid: full_session_id }`；hub 設定 `_focused_sid` 並觸發心跳。

---

## Stat Cards（統計卡片）

### Context Usage（上下文占用）

```
38%  / 200K
████████░░░░░░░░░░░
```

| 元素 | hb 欄位 | Hub 來源 | 前端計算 | 無資料 |
|------|---------|---------|---------|--------|
| 百分比 | `context_pct`, `tokens`, `budget` | `context_pct`：0–100 整數，來自 statusline `context_window.used_percentage`（官方預先算好）；`budget` 來自 statusline `context_window.context_window_size`（官方 context window 大小），fallback 為 `--budget` 參數 | 優先直接使用 `context_pct`；若缺失則 fallback 為 `clamp(round(tokens / budget × 100), 0, 100)` | `0% / 200K` |
| 進度條 | 同上 | — | `width: {pct}%`，500 毫秒過渡 | 空條 |
| 顏色閾值 | — | — | `< 50%` → 主色；`50–69%` → 黃；`≥ 70%` → 紅 + 發光 | — |
| 警告文案 | — | — | `≥ 50%` → "Warning: high usage"；`≥ 70%` → "Warning: near capacity" | 隱藏 |
| Budget 標籤 | `budget` | statusline `context_window.context_window_size`（預設 200 000），fallback 為 `--budget` 參數 | `formatTokens(budget)` → 如 `200K`、`1.2M` | `200K` |

### Active Model（當前模型）

| 元素 | hb 欄位 | Hub 來源 | 無資料 |
|------|---------|---------|--------|
| 模型名 | `model` | `model.display_name` 來自 statusline（如 `"Sonnet 4.6"`），存入 `_sess_model[sid]`。首次 statusline 到達前 fallback 為 transcript JSONL 解析 | `"—"` |
| 來源標籤 | `source` | `SessionStart` hook 的 `source` 欄位（如 `"startup"`、`"ide"`）| `"CLAUDE CODE"` |

### Cache Hit Rate（快取命中率）

| 元素 | hb 欄位 | Hub 來源 | 前端計算 | 無資料 |
|------|---------|---------|---------|--------|
| 百分比 | `cache_pct` | `int(cache_tokens × 100 / (input_tokens + cache_tokens))`；分母為 0 時為 0 | `round(cache_pct)` | `0%` |
| 進度條 | 同上 | — | `width: {pct}%` | 空條 |

**Token 累加規則** — 主要來源為 statusline payload（Claude Code 官方預計算，每隔幾秒發送）：

- `input_tokens` = `context_window.total_input_tokens`（工作階段累計，來自 statusline）
- `output_tokens` = `context_window.total_output_tokens`（工作階段累計，來自 statusline）
- `cache_tokens` = `context_window.current_usage.cache_read_input_tokens`（最新一次呼叫，反映當前 prompt 在快取裡的大小，**不累加**）

Fallback（statusline 未到達前）：transcript JSONL 只用來提取 `model` 和 `assistant_msg`，**不用於** token 統計。

### Session Cost（工作階段成本）

| 元素 | hb 欄位 | Hub 來源 | 前端計算 | 無資料 |
|------|---------|---------|---------|--------|
| 成本 | `cost_usd` | `cost.total_cost_usd` 來自 statusline — Claude Code 官方累計工作階段成本（USD），無需估算 | `$${cost.toFixed(2)}` | `$0.00` |
| Token 數 | `tokens` | `input_tokens + cache_tokens` | `formatTokens(tokens)` → 如 `76K` | `"No data"` |

---

## Metric Panels（指標面板）

### Token Distribution（Token 分佈）

焦點工作階段的 Token 類型分解，三條橫向進度條。

| 條 | hb 欄位 | Hub 來源 | 條寬 |
|-----|---------|---------|------|
| INPUT | `input_tokens` | `context_window.total_input_tokens` 來自 statusline（工作階段累計）| `inp / total × 100%` |
| OUTPUT | `output_tokens` | `context_window.total_output_tokens` 來自 statusline（工作階段累計）| `out / total × 100%` |
| CACHE | `cache_tokens` | `context_window.current_usage.cache_read_input_tokens` 來自 statusline（最新呼叫，不累加）| `cache / total × 100%` |

`total = inp + out + cache`（最小 1 防止除零）。  
數值用 `formatTokens()` 格式化：`< 1 000` → 原值；`≥ 1 000` → `NNK`；`≥ 1 000 000` → `N.NM`。

無資料：三個欄位全缺失 → 條全空，數值顯示 `0`。

> **為何 INPUT 看起來仍比 CACHE 小** — 長工作階段 + prompt caching 可能顯示 `INPUT = 40K` 對 `CACHE = 180K`。這是對的：CACHE 條是當前 prompt 大小，INPUT 條是工作階段開始以來模型「真正新看到」的累計內容。

### Operator Approvals（操作員審批）

計數**依焦點工作階段**，切換到其他工作階段會重置顯示。

| 格子 | hb 欄位 | Hub 來源 | 無資料 |
|------|---------|---------|--------|
| APPROVED | `approvals` | `_sess_approvals[sid]`，使用者每按一次 Approve 就 +1 | `0` |
| DENIED | `denials` | `_sess_denials[sid]`，使用者每按一次 Deny 或按 Escape 就 +1 | `0` |
| FAILED | `fail_count` | `_sess_fail_count[sid]`，每次 `PostToolUseFailure` hook 觸發就 +1 | `0` |

### Code Changes（程式碼變更）

| 元素 | hb 欄位 | Hub 來源 | 前端計算 | 無資料 |
|------|---------|---------|---------|--------|
| `+N` 插入 | `lines_added` | `cost.total_lines_added` 來自 statusline — Claude Code 官方統計的工作階段累計新增行數 | `+${added.toLocaleString()}` | `—` |
| `-N` 刪除 | `lines_removed` | `cost.total_lines_removed` 來自 statusline — 同上，刪除行數 | `-${removed.toLocaleString()}` | `—` |
| 進度條 | 同上 | — | `peak = max(added, removed, 1)`；插入條 = `added/peak × 100%`；刪除條 = `removed/peak × 100%`。較大值填滿 100%，較小值按比例縮放。 | 兩條全空 |

> `_refresh_git` 仍然執行，但只取得 `branch`（分支名）和 `dirty`（髒檔案數）供 Header 與 Sidebar 使用；行數統計已改由 statusline 提供，`_refresh_git` 不再計算插入／刪除行數。

> `null`（欄位缺失）和 `0`（零改動）顯示不同：`null` 顯示 `—`；`0` 顯示 `+0` / `-0`。

**工具呼叫次數**（進度條下方）：

| 元素 | hb 欄位 | Hub 來源 |
|------|---------|---------|
| 工具名 + 次數 | `tool_counts` | 每次 `PostToolUse` hook 觸發時 `_tool_counts[sid][tool_name]++` |

顯示順序：`Bash → Edit → Write → Read → Glob → Grep → WebFetch → WebSearch → Agent`，然後其他工具按字母序。全部顯示（無上限）。`tool_counts` 缺失或為空時整塊隱藏。

---

## Latest Response（最近回覆）

焦點工作階段最新一輪對話的終端機風格面板。

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

| 元素 | hb 欄位 | Hub 來源 | 無資料 |
|------|---------|---------|--------|
| 標題列路徑 | `project`, `branch` | `os.path.basename(git_root)` + `git rev-parse --abbrev-ref HEAD` | `"claude-code"` |
| 工作階段時間 | `started_at` | `datetime.fromtimestamp(_sess_start[sid]).strftime("%H:%M")` | 隱藏 |
| 提示字元行 | `model` | `_short_model()` → 小寫 + `:~$` | `claude:~$` |
| 使用者問題 | `human_msg` | `_on_user_prompt` hook 的 `prompt` 欄位，**保留換行**，智能 Markdown 截斷（min 300 字元），存入 `_sess_human[sid]`；以 Markdown 格式渲染，顯示在「YOU:」標籤下方 | 隱藏（不渲染）|
| 助理回覆 | `assistant_msg` | 主來源：`Stop` hook 的 `last_assistant_message`，智能 Markdown 截斷（min 500 字元，max 1500）。備用：transcript JSONL 最後一條 `role=assistant`。存入 `_sess_assistant[sid]`；以 GitHub Flavoured Markdown 渲染 | `"Waiting for response…"` |

`assistant_msg` 和 `human_msg` 都**依工作階段單獨儲存**——切換到沒有歷史的工作階段時這兩個欄位都會清空。

---

## Event Stream（事件流）

焦點工作階段的 hook 事件依時間順序展示。

```
Event Stream
│
●  15:03  Bash done
│
●  15:02  > fix the auth bug
│
●  15:01  session: claude-code-buddy
```

| 元素 | hb 欄位 | Hub 來源 |
|------|---------|---------|
| 事件條目 | `entries` | `_sess_transcript[sid]`（每個工作階段獨立的 `deque(maxlen=20)`），每條 `"HH:MM {body[:80]}"` |
| 顯示順序 | — | 最新在前；最多顯示 10 條；無計數徽章 |

**每個 hook 寫入 transcript 的內容：**

| Hook | 條目文字 |
|------|---------|
| `SessionStart` | `session: {project}` 或 `session started` |
| `Stop` | `session done` |
| `UserPromptSubmit` | `> {prompt[:60]}` |
| `PreToolUse` (bypass) | `{tool} (bypass)` |
| `PreToolUse` approved | `{tool} allow` |
| `PreToolUse` denied | `{tool} deny` |
| `PreToolUse` timeout (30 秒) | `{tool} timeout` |
| `PreToolUse` 選中選項 | `{tool} → {label[:30]}` |
| `PostToolUse` | `{tool} done` |
| `PostToolUseFailure` | `{tool} FAIL: {error[:60]}` |
| `Notification` | `[notify] {message[:60]}` |

**顏色規則**（依正文內容）：

| 顏色 | 條件 |
|------|------|
| 紅 | 含 `error`、`fail` 或 `denied` |
| 主色（金） | 含 `warn` 或 `approv` / `success` / `passed` |
| 綠 | 含 `approv`、`success`、`passed` |
| 主色/60 | 含 `tool`、`bash` 或 `read` |
| 灰 | 其他 |

條目**依工作階段單獨儲存**——切換工作階段只顯示該工作階段自己的事件。

---

## Approval Modal（審批彈窗）

`PreToolUse` hook 阻塞 Claude Code 等待決定時顯示的全螢幕遮罩。

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

| 元素 | hb 欄位 | Hub 來源 |
|------|---------|---------|
| 工具名 | `prompt.tool` | hook payload 的 `tool_name`，截斷到 19 字元 |
| 提示文字 | `prompt.hint` | `_hint()`：`Bash` → `command`；`Read/Edit/Write` → `file_path`；`WebFetch` → `url`；`WebSearch` → `query`。截斷到 43 字元 |
| 正文（程式碼區塊）| `prompt.body` | `_body()`：依工具拼接細節——Bash 顯示 description + command；Edit 顯示 old/new 差異；Write 顯示路徑 + 前 320 字元內容。截斷到 500 字元 |
| 工作階段徽章 | `prompt.sid` | `session_id[:8]` |
| 專案徽章 | `prompt.project` | `_sess_meta[sid]["project"]`，截斷到 23 字元 |
| 選項（AskUserQuestion）| `prompt.options` | question payload 的選項標籤，最多 4 個 |

**決策流：**

| 動作 | WebSocket 命令 | Hub 回應 |
|------|---------------|---------|
| 按 Approve | `{ cmd: "approve", id }` | `permissionDecision: "allow"` |
| 按 Deny / Escape | `{ cmd: "deny", id }` | `permissionDecision: "deny"` |
| 按選項按鈕 | `{ cmd: "option", id, index }` | `permissionDecision: "deny"`，reason 裡帶所選標籤（Claude 讀 reason 取得答案）|
| 30 秒無動作 | *(逾時)* | `permissionDecision: "deny"`，理由 "buddy hub: no user decision within 30s"——顯式 fail-closed，避免漏看的請求被預設放行 |

多個並行審批請求會排隊；每次決定後彈窗自動推進到下一個。

---

## Mobile Bottom Navigation（行動裝置底部導覽）

窄於 `md`（768 px）的螢幕上顯示。只有一個 **Sessions** 按鈕，切換左側抽屜覆蓋主內容。抽屜裡是和桌面側邊欄一樣的工作階段清單；點工作階段列會 focus 並關閉抽屜。點遮罩也可關閉抽屉。
