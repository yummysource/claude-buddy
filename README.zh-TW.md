# claude-code-buddy

用於監控 Claude Code 工作階段的即時儀表板和可選硬體顯示裝置。Claude Code hook 把事件 POST 到本機 Python hub，hub 透過 WebSocket 把完整心跳快照推送到 Next.js Web UI（可選同時推送到序列埠或 BLE 硬體裝置）。介面允許遠端核可或拒絕工具呼叫，手機在同一區域網路時同樣可用。

[English](README.md) | [简体中文](README.zh-CN.md)

## 示範影片

[![Claude Code Buddy 即時工作階段監控示範](https://img.youtube.com/vi/SEFFsbFHAD8/maxresdefault.jpg)](https://youtu.be/SEFFsbFHAD8)

## 截圖

**桌面端**

<table>
  <tr>
    <td><img src="assets/web-light.png" alt="儀表板 — 淺色模式"></td>
    <td><img src="assets/web-dark.png" alt="儀表板 — 深色模式"></td>
  </tr>
  <tr>
    <td align="center"><sub>淺色模式</sub></td>
    <td align="center"><sub>深色模式</sub></td>
  </tr>
</table>

<img src="assets/web-approve.png" alt="操作員審批彈窗" width="600">

**行動裝置**

<table>
  <tr>
    <td><img src="assets/mobile-light.JPG" alt="行動裝置 — 淺色" width="220"></td>
    <td><img src="assets/mobile-dark.JPG" alt="行動裝置 — 深色" width="220"></td>
    <td><img src="assets/mobile-approve.PNG" alt="行動裝置 — 審批" width="220"></td>
  </tr>
  <tr>
    <td align="center"><sub>淺色</sub></td>
    <td align="center"><sub>深色</sub></td>
    <td align="center"><sub>審批</sub></td>
  </tr>
</table>

## 功能亮點

- **即時工作階段監控** — 狀態、模型、上下文占用率隨每次 hook 更新。
- **遠端審批 UI** — 在瀏覽器（桌面/手機）核可或拒絕 `PreToolUse` 請求。
- **多工作階段支援** — 多個並行 Claude Code 工作階段共用同一儀表板，側邊欄最多顯示 5 個。
- **Token 用量與成本追蹤** — 依輸入/輸出/快取拆分，依模型定價計算美元成本。
- **依工作階段記錄 Git 狀態** — 當前分支、髒檔案數、已提交與未提交行數差。
- **事件流時間線** — 當前工作階段的 hook 事件依時間排列並依類型著色。
- **可選硬體顯示** — 同一份心跳可推送到序列埠或 Nordic UART BLE 裝置。

## 架構

```
  Claude Code                Python hub                   Next.js 前端
  hooks + statusLine         (BuddyHub)                   (Bun dev server)
  ──────────                 ──────────                   ────────────────
       │                          │                             │
       │  POST /hook              │                             │
       │  127.0.0.1:7381          │                             │
       │   • hook 事件            │                             │
       │   • statusLine 指標      │                             │
       ├─────────────────────────▶│                             │
       │                          │  WebSocket                  │
       │                          │  :7382                      │
       │                          ├────────────────────────────▶│  ◀── 瀏覽器
       │                          │                             │      (桌面 / 同區網的手機)
       │                          │  序列埠 / BLE (可選)         │
       │                          ├──▶  硬體顯示                  │
```

每一幀心跳是當前焦點工作階段的完整 JSON 快照——完整欄位來源說明見 [DASHBOARD.zh-TW.md](DASHBOARD.zh-TW.md)。

## 先決條件

- Python 3.11 或更新版本，並已安裝 [`uv`](https://docs.astral.sh/uv/)。
- [Bun](https://bun.sh) 1.x，或 Node.js 20 或更新版本。
- Claude Code 已安裝且可從命令列執行。

## 安裝

```bash
git clone https://github.com/<your-fork>/claude-code-buddy.git
cd claude-code-buddy/server/python && uv sync
cd ../../web && bun install
```

## 接入 Claude Code

### 1. Hook 事件

把 `hooks/post-hook.sh` 拷貝到 `~/.claude/hooks/`，然後把 [`hooks/settings.json`](hooks/settings.json) 中的 `hooks` 區塊合併到 `~/.claude/settings.json`。

每個 hook 都呼叫 `$HOME/.claude/hooks/post-hook.sh`，由指令稿先緩衝 stdin，再把事件 POST 到 `http://127.0.0.1:7381/hook`，並始終以 `{}` 退出碼 0 傳回——保證 hub 離線時 Claude Code 仍可正常執行。如果不走包裝指令稿，curl 在連線被拒後可能在讀完 stdin 之前退出，hook 命令的退出碼會被判為失敗。

### 2. Statusline（上下文占用、成本、Token 數、程式碼行數）

儀表板裡的核心指標——上下文視窗百分比、工作階段成本、累計 Token 數、程式碼新增/刪除行數——來自 Claude Code 的 `statusLine` 機制，**不是** 來自上面的 hooks。把 `hooks/statusline.sh` 拷貝到 `~/.claude/hooks/`（和 `post-hook.sh` 放一起），然後在 `~/.claude/settings.json` 裡加一個 `statusLine` 區塊：

```jsonc
// ~/.claude/settings.json
{
  "hooks": { /* ... 來自 hooks/settings.json ... */ },
  "statusLine": {
    "type": "command",
    "command": "$HOME/.claude/hooks/statusline.sh",
    "padding": 0
  }
}
```

[`hooks/statusline.sh`](hooks/statusline.sh) 是一個最小化腳本：從 stdin 讀取 payload，後台轉發給 hub，並在終端機狀態列輸出 `🤖 模型 · 🧠 N% · 💰 $0.00`。終端機顯示部分需要 `jq`（`brew install jq`），轉發功能不依賴 `jq`。

**已有自訂 statusline 腳本？** 在你的 `INPUT=$(cat)` 之後加這三行：

```bash
INPUT=$(cat)

# claude-code-buddy：把 payload 轉發給 hub
echo "$INPUT" | curl -sS --max-time 3 -X POST --data-binary @- \
  http://127.0.0.1:7381/hook >/dev/null 2>&1 &
```

### 3. 批准流程與三層告警

Claude Code 發起需要批准的工具呼叫時，hub 會阻塞這條 hook **最多 30 秒**，等儀表板按 `approve` / `deny`：

- 操作員按 **Approve** → `permissionDecision: "allow"`
- 操作員按 **Deny / Escape** 或選項按鈕 → `permissionDecision: "deny"`
- **30 秒內無動作** → `permissionDecision: "deny"`（fail-closed；reason 為 `"buddy hub: no user decision within 30s"`）

fail-closed 是刻意設計的：如果 hub 回傳空字典，Claude Code 會走它自己的內建 default，而這個 default 歷史上隨版本不同可能是 "ask" 或 "allow"——漏看的請求就會默默放行。hub 改為明確回傳 deny 把這條路堵死。

為了讓這 30 秒不會被漏掉，儀表板在批准請求待處理時會同時啟動三層告警：

1. **標題閃爍** — `document.title` 每 1 秒切換一次，分頁在背景時也看得到。
2. **系統通知** — `requireInteraction: true`，點擊通知會把儀表板分頁拉到前台。
3. **聲音提示** — 880Hz 短鈴聲，每 8 秒重播。

模態卡片本身在頂端繪製一條左→右消耗的進度條，右上角 Shield 圖示下方顯示 `Xs` 倒數；剩 10 秒以內時整體變紅色。

> **瀏覽器限制。** `Notification.requestPermission()` 和 `AudioContext` 都需要使用者手勢才能初始化。儀表板在第一次 `pointerdown` 時自動 bootstrap——你**沒點過頁面**之前，只有標題閃爍會動，通知和聲音會靜默失敗。

如果 Claude Code 啟動時帶 `--dangerously-skip-permissions`（或者 `permissions.defaultMode: "bypassPermissions"`），hub 會跳過整個批准流程直接回傳 `allow`，事件流裡記一行 `{tool} (bypass)` 以便稽核。

## 啟動

| 情境             | hub 命令                                                  | 前端命令           | 存取 URL                        |
|------------------|-----------------------------------------------------------|---------------------|---------------------------------|
| 僅本機           | `uv run python -m hub`                                    | `bun run dev`       | `http://localhost:3000`         |
| 區域網 + token   | `uv run python -m hub --host 0.0.0.0`                     | `bun run dev`       | 從 hub banner 複製 URL           |
| 區域網免驗證     | `uv run python -m hub --host 0.0.0.0 --no-auth`           | `bun run dev`       | `http://<LAN-IP>:3000`          |

hub 從 `server/python/` 啟動，前端從 `web/` 啟動。hub 會在 stderr 列印可直接複製的存取資訊，例如：

```
  Access:
    http://localhost:3000?token=abc…
    http://192.168.1.42:3000?token=abc…

  WebSocket token: abc…
  (stored at /Users/you/.config/claude-buddy/token)
```

Token 會持久化到 `~/.config/claude-buddy/token`，權限 `0600`，所以重啟 hub 後手機書籤仍然有效。要輪換 token：啟動時加不帶值的 `--token`（自動產生新 token 並覆寫檔案）；或用 `--token VALUE` 只在本次啟動使用 VALUE（不改檔案）。

## 從手機存取

1. 在電腦上執行：`uv run python -m hub --host 0.0.0.0`
2. 讓手機和電腦連到同一 Wi-Fi。
3. 從 hub banner 中複製一條 `http://<LAN-IP>:3000?token=…` 形式的 URL，貼到手機瀏覽器打開。

如果介面頂部顯示紅色 **Unauthorized** 橫幅，表示 URL 裡的 token 與 hub 不符——重新從 banner 複製完整 URL 即可。

## CLI 參數

| 參數             | 預設值        | 說明                                                                                         |
|------------------|---------------|---------------------------------------------------------------------------------------------|
| `--host`         | `127.0.0.1`   | WebSocket 綁定位址。`0.0.0.0` 把 hub 暴露到區域網，此時需要 token（除非同時指定 `--no-auth`）。|
| `--port`         | `7381`        | HTTP hook 監聽埠。無論 `--host` 取什麼值，一律綁定在 `127.0.0.1`。                             |
| `--ws-port`      | `7382`        | WebSocket 推送埠。                                                                            |
| `--token`        | _(自動產生)_  | 不帶值的 `--token` 輪換持久化 token；`--token VALUE` 只在本次啟動使用 VALUE 不改檔案。loopback 綁定時忽略。 |
| `--no-auth`      | 關閉          | 即便在 LAN 綁定下也不啟用 token 驗證。僅在可信任網路使用。                                    |
| `--budget`       | `200000`      | 上下文 token 預算，用於進度條。`0` 隱藏進度條。                                                |
| `--owner`        | `$USER`       | 儀表板頂部顯示的 owner 名稱。                                                                  |
| `--transport`    | `auto`        | 硬體 transport：`auto` / `serial` / `ble` / `none`。                                          |
| `--serial-port`  | _(無)_        | 明確序列埠裝置路徑；會覆寫 `--transport`。                                                     |

## 儀表板概觀

整個 UI 由每次更新一份 JSON 心跳驅動。主要元件：

- **Header（頂列）** — 連線指示點、工作階段開始時間、即時計時器、工作階段數、狀態徽章、當前分支。來源：`started_at`、`started_ts`、`running`、`branch`。
- **Sidebar（側邊欄）** — 最多 5 個工作階段，每條顯示專案名、分支、髒檔案數、狀態點。點擊切換焦點。來源：`hb.sessions[]`。
- **Stat cards（統計卡片）** — 上下文占用（`tokens`/`budget`）、當前模型（`model`、`source`）、快取命中率（`cache_pct`）、工作階段成本（`cost_usd`、`tokens`）。
- **Metric panels（指標面板）** — Token 分佈（`input_tokens`/`output_tokens`/`cache_tokens`）、審批統計（`approvals`、`denials`、`fail_count`）、程式碼變更（`lines_added`、`lines_removed`、`tool_counts`）。
- **Latest Response（最近回覆）** — 終端機風格面板，顯示焦點工作階段的使用者問題（`human_msg`）和助理回答（`assistant_msg`）。
- **Event Stream（事件流）** — 焦點工作階段的 hook 事件時間線（`entries`）。
- **Approval Modal（審批彈窗）** — `PreToolUse` hook 等待決定時的全螢幕遮罩。按鈕透過同一個 WebSocket 送出 `{cmd: "approve" | "deny" | "option", id}`。

每個指標的完整來源與計算方式詳見 [DASHBOARD.zh-TW.md](DASHBOARD.zh-TW.md)——包含每個欄位的 hub 來源以及前端的展示邏輯。

## 疑難排解

- **Next.js 顯示 "Blocked cross-origin request to Next.js dev resource"** — `next.config.ts` 啟動時自動收集所有非內部 IPv4。換 Wi-Fi 或 IP 變動後，需要重啟 `bun run dev` 重新讀取網卡。
- **Chrome 對 LAN IP 強制跳 HTTPS（`ERR_SSL_PROTOCOL_ERROR`）** — 網址列明確輸入 `http://` 前綴；或開啟 `chrome://net-internals/#hsts`，在 **Delete domain security policies** 下輸入 IP 清除記錄。
- **手機顯示 "Disconnected"** — 查看橫幅上顯示的 WebSocket URL，確認它指向你的 LAN IP 而不是 `localhost`。直接從 banner 複製 URL，不要手動輸入。
- **重啟 hub 後 token 沒變** — 這是刻意的。啟動時加不帶值的 `--token` 即可輪換；或手動刪除 `~/.config/claude-buddy/token`。

## 開發

```bash
# Python hub — 每次改完都跑一下語法檢查
cd server/python
uv run python -m py_compile hub/*.py

# 前端
cd web
bun run build
```

完整編碼規則見 [AGENTS.md](AGENTS.md)，Claude Code 相關細節見 [CLAUDE.md](CLAUDE.md)。

## 授權

MIT
