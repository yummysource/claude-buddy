# claude-code-buddy

用於監控 Claude Code 工作階段的即時儀表板和可選硬體顯示裝置。Claude Code hook 把事件 POST 到本機 Python hub，hub 透過 WebSocket 把完整心跳快照推送到 Next.js Web UI（可選同時推送到序列埠或 BLE 硬體裝置）。介面允許遠端核可或拒絕工具呼叫，手機在同一區域網路時同樣可用。

[English](README.md) | [简体中文](README.zh-CN.md)

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
  (hooks)                    (BuddyHub)                   (Bun dev server)
  ──────────                 ──────────                   ────────────────
       │                          │                             │
       │  POST /hook              │                             │
       │  127.0.0.1:7381          │                             │
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

## 接入 Claude Code hook

把 [`hooks/settings.json`](hooks/settings.json) 中的 `hooks` 區塊合併到 `~/.claude/settings.json`。

每個 hook 把 Claude Code 的事件 POST 到 `http://127.0.0.1:7381/hook`。命令末尾的 `|| echo '{}'` 保證 hub 離線時 Claude Code 仍可正常執行——curl 失敗時會給 hook runner 傳回空 JSON 物件，而不是阻塞工作階段。

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
