# task-tracker

A Claude Code plugin that keeps a **side pane recording the current session**: what was discussed, decided, produced and is still pending, so you do not have to scroll back through the chat. When you work on several things at once, each one is a collapsible card.

## What the pane shows

- **Needs you** (pinned on top): every open question across all cards, each tagged with its card. Click one to expand that card. Can be turned off (see Configuration).
- **Awaiting merge** (right below Needs you): pull requests opened this session that still wait for you to merge, clickable, tagged with their topic when one is given. Claude adds one when it opens a PR and removes it once you say it is merged.
- **Summary**: a few lines on where the session stands (what got done, what is left), rewritten by Claude as work moves on. Can be turned off (`showSummary`).
- **Parked prompts** (right below Summary): questions you saved to ask later, kept across sessions and shared by every repo (see below).
- **Testing**: URLs you are asked to test right now (preview or test environments), clickable, each with an optional note. Removed once testing is over.
- **Created**: links to things created this session (issues, PRs, pages), clickable.
- **Local changes**: changes left on your machine that outlive the session: a registered scheduled task, an environment variable, a switched account, a deployed service (with version), a written memory. Temporary leftovers (worktree, branch, test session, temp directory) are flagged `CLEAN UP` and removed once cleaned.
- **Topics**: one card per thing worked on this session, sorted 👉 doing / ❓ needs you / ⏳ waiting on others / ⬜ todo / ✅ done. Collapsed it is one line (title + where it stands); expanded it shows: now, background, decided, outputs (GitHub links are clickable and shown as `repo#123`), pending, asks, and the subagents launched for that topic.
- **Agents**: a subagent you launch is filed under the current topic (marked "now"); while running it shows elapsed time and tool-call count, and once finished you can expand the result summary Claude wrote. Agents without a topic are listed under "Other agents".

Session-level sections (Awaiting merge, Summary, Testing, Created, Local changes) fold: click the header (`▾` / `▸`) to collapse or expand; the header keeps showing the item count, e.g. `Local changes (7)`. Local changes starts folded, the others start open; the choice is kept in the session state (reset by `/clear`). Needs you and the topic cards are unchanged.

In **Created**, every row has a `⧉ copy` button, and the header has `⧉ copy all`. By default (`copyFormat: rich`) the copy is a real hyperlink, like Tab Copy: the plugin writes an HTML flavor (`<a href="url">label</a>`; for copy all a `<ul>` of links) plus a plain-text flavor (`label url`, one per line) through the operating system, so pasting into Lark, Notion, Slack, Gmail or Word gives a clickable link. Mechanism per platform: Windows runs the system `powershell.exe` (Windows PowerShell 5.1, `-STA`) with `System.Windows.Forms.Clipboard` and a CF_HTML block (UTF-8); macOS runs `osascript` setting `«class HTML»` plus text; Linux uses `wl-copy --type text/html`, else `xclip -selection clipboard -t text/html` (HTML flavor only). Labels and URLs are passed as data (JSON on stdin, or hex literals), never spliced into a command line. If the runtime cannot start a process, the platform is unsupported, or a tool fails, the copy falls back to the Markdown link `[label](url)` through the host's `$.ui.copy` (terminal clipboard tool / OSC 52). The button briefly shows `✓ Copied (rich link)`, `✓ Copied (Markdown)` or `✗ Copy failed`. Only Windows is verified so far; macOS and Linux are untested.

**Created** is grouped by type, in this order and hiding empty groups: **Issues** (a numbered list), **PRs** (a plain bullet list), **Other** (pages and the rest; a plain bullet list). An entry with `parent` (the url of its epic / parent issue) is listed under that parent as a sub-item (`1.1`, `1.2`, ...); if the parent is not in the list, or is itself a sub-issue, the entry is shown at top level. `kind` is `issue`, `pr` or anything else (page ...); without a `kind` it is inferred from the url (`/pull/N` is a PR, `/issues/N` is an issue, otherwise Other). Each group title has a `⧉ copy group` button, and `⧉ copy all` copies every group; a row's own `⧉ copy` is unchanged. The copy keeps the structure in all three `copyFormat`s: `rich` writes HTML `<p><b>Issues</b></p><ol><li><a>…</a><ol><li><a>…</a></li></ol></li></ol><p><b>PRs</b></p><ul>…</ul>` plus a plain-text flavor (`Issues` / `1. label url` / `   1.1 label url` / `PRs` / `- label url`); `markdown` writes `**Issues**`, `1. [label](url)`, three-space-indented `   1. [label](url)` sub-items, `**PRs**`, `- [label](url)`; `plain` writes the plain-text form. Group names follow `uiLanguage` (en: Issues / PRs / Other; zh and zh-TW: Issue / PR / 其他).

`copyFormat` (setting): `rich` (default), `markdown` (always `[label](url)` text, no process started) or `plain` (`label url` text).

Session-level sections (Summary, Testing, Created) belong to the whole session, not to a topic, and are hidden while empty. Top to bottom: Needs you, Awaiting merge, Summary, Parked prompts, Testing, Created, Local changes, Topics, Other agents.

The pane opens by itself the first time it has content; reopen it with `/tracker`.

## Parked prompts

Sometimes you think of a question you do not want to ask right now. Park it, and ask it later.

- **Save**: type `/park <text>` (stored; the text is **not** sent to Claude and starts no turn), or tell Claude "park that" / "save this for later" and it calls `park_prompt`.
- **Storage**: one list for the whole machine, not per session: every repo and every session shares it, and `/clear`, `/compact` and restarts never touch it. It is kept in the plugin's own store (`$.store`), a JSON file under your Claude Code configuration directory (`plugins/store/`, named after the plugin). Each item: `id`, `text`, `created_at`, `repo`, `session` (`id` and `name`), `status` (`open` or `asked`), `asked_at`. `repo` is the git top-level directory name (the main working tree's for a worktree), or the last segment of the working directory outside git. The plugin API gives no session title, so `session.name` is the date and time the session began.
- **Pane section** "Parked prompts" (hidden when empty, `showParked` turns it off): grouped repo, then session, then item. The current repo is on top and open; other repos are folded and show their count. Inside a repo the current session is open, others are folded (date and count). An item is one truncated line with its time, and four buttons: `↵ fill` (puts the text in the prompt box, after what you already typed; it does not send), `⧉ copy` (plain text), `✓ asked` (marks it asked and hides it) and `✗ delete`. Asked items are hidden; a repo header offers `show asked (n)`, where each asked item has `↺ reopen`.
- **Claude can read them**: say "show my parked prompts" and Claude calls `list_parked`.

Shared storage caveat: the store file is per plugin install, so the same plugin installed twice (for example from two marketplaces, or loaded with `--plugin-dir`) keeps separate lists.

## Session lifecycle

| When | Pane |
|---|---|
| `/compact` (manual or automatic) | kept, and the whole record (topics, summary, testing, created, awaiting merge, local changes) is handed to the compaction summary so Claude realigns with it afterwards |
| `/clear` | emptied (topics, agents, summary, testing, created, awaiting merge, local changes), new work starts |
| New session | starts empty (data lives in the session state) |

Only this session's work belongs on the pane. Put follow-ups that outlive the session in your own project's tracker.

## Install

At the prompt of a Claude Code terminal session (user scope makes it available in every repo):

```
/plugin install task-tracker --marketplace jackywooks/task-tracker
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install task-tracker --marketplace jackywooks/task-tracker`. Requires Claude Code 2.1.275 or later. Try it without installing: `claude --plugin-dir <path to this folder>`.

## Configuration

Set when installing, or later in `/config` (each field is a row there):

| Option | Default | Meaning |
|---|---|---|
| `title` | `Task Tracker` | Title of the pane (also used in the tool descriptions). |
| `language` | empty | Language Claude writes the cards in, e.g. `Simplified Chinese`. Empty follows the language of the conversation. |
| `uiLanguage` | `en` | Language of the fixed pane labels: `en` (English), `zh` / `zh-CN` (Simplified Chinese) or `zh-TW` (Traditional Chinese). Unknown values fall back to `en`. |
| `asksOnTop` | `true` | Show the "Needs you" section on top. |
| `showSummary` | `true` | Show the session Summary section. |
| `showParked` | `true` | Show the Parked prompts section. |
| `copyFormat` | `rich` | Copy format of Created links: `rich` (HTML + text hyperlink via the OS, Markdown fallback), `markdown`, `plain`. |

## Tools Claude uses

| Tool | Purpose |
|---|---|
| `mcp__task-tracker__set_topics` | Merge-update cards by `id`: pass only the topics that changed and only the changed fields (an empty array clears a field). Fields: `title`, `status` (doing, waiting, blocked, todo, done), `line`, `background`, `decided[]`, `outputs[]`, `pending[]`, `asks[]`; plus `now` (id of the current topic) and `remove` (delete cards). |
| `mcp__task-tracker__set_agent_summary` | After a subagent finishes and its report is read, record what it delivered (2-5 points); can re-file it under another topic with `topic`. |
| `mcp__task-tracker__set_session` | Session-level record: `summary` (text, replaces the old one), `testing[]` (`{label, url, note?}`, URLs under test), `created[]` (`{label, url, kind?, parent?}`, issues / PRs / pages created; `parent` is the epic / parent issue url of a sub-issue), `merges[]` (`{label, url, topic?}`, PRs awaiting your merge), all merged by `url`; `changes[]` (`{label, detail?, cleanup?}`, local changes) merged by `label`; `untest_urls[]` deletes from testing only, `merged_urls[]` deletes from merges only (the PR stays under Created), `remove_urls[]` deletes from testing, created and merges all at once (generally for entries added by mistake), `remove_labels[]` deletes from changes. Claude is told to add a link right after creating an issue / PR / page, to add a PR to `merges` when it opens it and drop it with `merged_urls` when you merge, to list a preview URL while you test it and drop it with `untest_urls` afterwards, to record local changes (with `cleanup: true` for temporary leftovers) and remove them once cleaned, and to keep the summary current. |

| Tool | Purpose |
|---|---|
| `mcp__task-tracker__park_prompt` | `{text}`: save a prompt to ask later. Claude is told to call it only when you ask it to park or save something. |
| `mcp__task-tracker__list_parked` | `{repo?, status?}` (`status`: `open` or `asked`): read the parked prompts, for example when you say "show my parked prompts". |
| `mcp__task-tracker__update_parked` | `{id, status?, text?, delete?}`: mark asked or reopen, rewrite, or delete one parked prompt. |

Rules baked into the tool descriptions:

- **One open question, one card.** When one thing spawns several questions for you, give each its own card (`background` says what it is and why it needs deciding, `asks` holds the full question with options and a recommendation) and keep one separate overview card for progress. Update that card's `asks` when the question changes so no stale question stays pinned.
- **Codes come with names.** When plan steps use codes (P0, A1, B2), write "code name" everywhere the code appears (e.g. "A2 Board and write scope moved to config"), never the bare code. A plan-type topic (a multi-step project) gets one overview card whose `pending` / `outputs` list all steps, one per line, as "code name: status", so the codes in Claude's replies can be matched to the pane.
- Outputs carry full URLs; the pane shortens GitHub links and keeps them clickable.
- No circled digits (they break terminal width); use (1)(2).

## Development

```
claude plugin validate <path to this folder>
```

Type check: once the engine has loaded the plugin it writes types and a `tsconfig.json` under `.claude-plugin/types/` (git-ignored); then run `tsc -p <path to this folder>`. The line matching the MCP tool name in `tool.call` hooks may report TS2589 (type instantiation too deep); it does not affect runtime.

## License

MIT — see [LICENSE](LICENSE).

---

## 简体中文说明

task-tracker 是 Claude Code 插件：在对话旁边放一个「事项总览」侧栏，记录本会话说过什么、定了什么、产出什么、还差什么，不用往上翻聊天记录。同时做几件事时，每件事一张可折叠卡片；所有待你回答的问题汇总在置顶的「等你」。

- 安装：`/plugin install task-tracker --marketplace jackywooks/task-tracker`（用户级，所有 repo 可用）。
- 配置（安装时或 `/config`）：`title` 面板标题（默认 Task Tracker，可填「事项总览」）；`language` 卡片写作语言（留空跟随对话，如填 `Simplified Chinese`）；`uiLanguage` 面板固定文字 `en`（英文）/ `zh` 或 `zh-CN`（简体）/ `zh-TW`（繁体，台湾用语）；`asksOnTop` 是否置顶「等你」。
- 一个待定问题一张卡；计划步骤用代号时，凡出现代号都写「代号 名称」，计划类话题要有总览卡列出全部步骤「代号 名称：状态」。
- `/compact` 保留面板并把内容交给摘要；`/clear` 清空；新会话从空开始；只放本会话的事。
- 会话级三块（与「话题」同级、为空不显示）：「总结」（几行，做成了什么、还差什么）、「测试中」（正在测的 URL，可点）、「已创建」（本会话建的 issue / PR / 页面链接，可点）；由工具 `set_session` 写入，`showSummary` 可关总结。另有「等合并」（本会话开出、等你合的 PR，紧贴「等你」下方）与「本机改动」（会话后仍留在本机的定时任务 / 环境变量 / 账号 / 部署 / memory 等，临时 worktree / 分支 / 测试 session / 临时目录标「待清理」）。面板顺序：等你、等合并、总结、测试中、已创建、本机改动、话题。`/compact` 一并交给摘要，`/clear` 清空。
- 会话级区块（等合并、总结、测试中、已创建、本机改动）点标题（`▾` / `▸`）可收起 / 展开，标题后始终显示条数（如「本机改动 (7)」）；「本机改动」默认收起，其余默认展开；状态存在会话 state，`/clear` 重置；「等你」和话题卡片不变。「已创建」每行有「⧉ 复制」按钮，标题处有「⧉ 全部复制」。默认（`copyFormat: rich`）复制的是真正的富链接（类似 Tab Copy）：通过操作系统同时写入 HTML（`<a href="url">label</a>`，全部复制为 `<ul>` 列表）和纯文本（`label url`，每行一条），粘贴到 Lark、Notion、Slack、邮件、Word 都是可点的链接。各平台机制：Windows 调系统自带 `powershell.exe`（5.1，`-STA`）+ `System.Windows.Forms.Clipboard` 写 CF_HTML（UTF-8）；macOS 用 `osascript` 设 `«class HTML»` 与文本；Linux 用 `wl-copy --type text/html`，否则 `xclip -selection clipboard -t text/html`（仅 HTML）。label / url 只作为数据传入（stdin 的 JSON 或十六进制字面量），不拼进命令行。运行时不允许起子进程、平台不支持或工具失败时，退回 Markdown 链接 `[label](url)`（走宿主 `$.ui.copy`）。按钮短暂显示「✓ 已复制（富链接）」/「✓ 已复制（Markdown）」/「✗ 复制失败」。目前只在 Windows 验证过，macOS / Linux 未验证。配置项 `copyFormat`：`rich`（默认）/ `markdown`（始终 `[label](url)` 文本）/ `plain`（`label url` 文本）。
- 「已创建」按类型分组，顺序为 **Issue**（编号列表）→ **PR**（普通项目符号列表）→ **其他**（页面等，普通项目符号列表），空组不显示。带 `parent`（所属 epic / 父 issue 的 url）的条目缩进挂在父项下面，用子编号（`1.1`、`1.2`…）；父项不在列表里、或父项本身也是子 issue 时，按顶层显示。`kind` 取 `issue`、`pr` 或其他（page 等）；没给 `kind` 时按 url 推断（`/pull/N` 为 PR，`/issues/N` 为 issue，其余归「其他」）。每组标题旁有「⧉ 复制本组」，「⧉ 全部复制」按分组输出；单行「⧉ 复制」不变。三种 `copyFormat` 都带结构：`rich` 写 HTML `<p><b>Issue</b></p><ol><li><a>…</a><ol><li><a>…</a></li></ol></li></ol><p><b>PR</b></p><ul>…</ul>` 加纯文本（`Issue` / `1. label url` / `   1.1 label url` / `PR` / `- label url`）；`markdown` 写 `**Issue**`、`1. [label](url)`、缩进三空格的 `   1. [label](url)` 子项、`**PR**`、`- [label](url)`；`plain` 写纯文本形式。组名随 `uiLanguage`（zh 与 zh-TW：Issue / PR / 其他）。

- **待问（Parked prompts）**：想问但当下不问的问题，存起来稍后再问。`/park <内容>` 存一条（只存储，**不会发给 Claude**，也不触发回合），或对 Claude 说「存起来」由它调用 `park_prompt`。存储是整台机器共用的一个库：所有 repo、所有会话共享，`/clear`、`/compact`、重开都不清；放在插件自己的 store（`$.store`，Claude Code 配置目录下 `plugins/store/` 里的一个 JSON 文件）。每条含 `id`、`text`、`created_at`、`repo`（git 顶层目录名，worktree 取主工作树；不在 git 里取工作目录末段）、`session`（`id` 与 `name`；API 没有会话标题，`name` 为会话开始的日期时间）、`status`（`open` / `asked`）、`asked_at`。面板新增「待问」区块（紧跟「总结」，为空不显示，`showParked` 可关）：按 repo → 会话 → 条目分组；当前 repo 置顶并展开，其他 repo 收起并显示条数；repo 内当前会话展开，其他会话收起（显示日期和条数）。每条一行（截断）加时间，按钮：`↵ 填入`（把文字放进输入框，追加在已有草稿后，不发送）、`⧉ 复制`（纯文本）、`✓ 已问`（标记并隐藏）、`✗ 删除`；已问默认隐藏，repo 标题处可「显示已问 (n)」，已问条目有「↺ 恢复」。对 Claude 说「把待问拿出来」，它会调用 `list_parked`；`update_parked` 用于改状态 / 改文字 / 删除。注意：store 文件按插件安装区分，同一插件装了两份（如两个 marketplace，或用 `--plugin-dir` 加载）会各有一份列表。
- License：MIT。

## 繁體中文說明

task-tracker 是 Claude Code 外掛：在對話旁放一個「事項總覽」側欄，記錄本工作階段談了什麼、決定了什麼、產出什麼、還差什麼。介面語言設定 `uiLanguage` 可選 `en`、`zh`（簡體，同 `zh-CN`）、`zh-TW`（繁體）；填 `zh-TW` 即可讓面板固定文字顯示繁體。卡片內容的語言由 `language` 控制（例如填 `Traditional Chinese`）。

「已建立」每行有「⧉ 複製」按鈕，標題處有「⧉ 全部複製」。預設（`copyFormat: rich`）複製的是真正的富連結（類似 Tab Copy）：透過作業系統同時寫入 HTML（`<a href="url">label</a>`，全部複製為 `<ul>` 清單）與純文字（`label url`，每行一筆），貼到 Lark、Notion、Slack、郵件、Word 都是可點的連結。各平台機制：Windows 呼叫系統內建 `powershell.exe`（5.1，`-STA`）＋ `System.Windows.Forms.Clipboard` 寫入 CF_HTML（UTF-8）；macOS 以 `osascript` 設定 `«class HTML»` 與文字；Linux 用 `wl-copy --type text/html`，否則 `xclip -selection clipboard -t text/html`（僅 HTML）。label / url 僅作為資料傳入（stdin 的 JSON 或十六進位字面量），不拼進命令列。執行環境不允許啟動子行程、平台不支援或工具失敗時，退回 Markdown 連結 `[label](url)`（走宿主 `$.ui.copy`）。按鈕短暫顯示「✓ 已複製（富連結）」/「✓ 已複製（Markdown）」/「✗ 複製失敗」。目前僅在 Windows 驗證過，macOS / Linux 未驗證。設定 `copyFormat`：`rich`（預設）/ `markdown`（一律 `[label](url)` 文字）/ `plain`（`label url` 文字）。

「已建立」依類型分組，順序為 **Issue**（編號清單）→ **PR**（一般項目符號清單）→ **其他**（頁面等，一般項目符號清單），空組不顯示。帶 `parent`（所屬 epic / 父 issue 的 url）的條目縮排掛在父項下面，使用子編號（`1.1`、`1.2`…）；父項不在清單裡、或父項本身也是子 issue 時，視為頂層。`kind` 為 `issue`、`pr` 或其他（page 等）；沒給 `kind` 時依 url 推斷（`/pull/N` 為 PR，`/issues/N` 為 issue，其餘歸「其他」）。每組標題旁有「⧉ 複製本組」，「⧉ 全部複製」依分組輸出；單行「⧉ 複製」不變。三種 `copyFormat` 都帶結構：`rich` 寫 HTML `<p><b>Issue</b></p><ol><li><a>…</a><ol><li><a>…</a></li></ol></li></ol><p><b>PR</b></p><ul>…</ul>` 加純文字（`Issue` / `1. label url` / `   1.1 label url` / `PR` / `- label url`）；`markdown` 寫 `**Issue**`、`1. [label](url)`、縮排三個空格的 `   1. [label](url)` 子項、`**PR**`、`- [label](url)`；`plain` 寫純文字形式。組名隨 `uiLanguage`（zh 與 zh-TW：Issue / PR / 其他）。

**待問（Parked prompts）**：想問但當下不問的問題，存起來稍後再問。`/park <內容>` 存一條（只儲存，**不會送給 Claude**，也不觸發回合），或對 Claude 說「存起來」由它呼叫 `park_prompt`。儲存是整台機器共用的一個庫：所有 repo、所有工作階段共享，`/clear`、`/compact`、重新開啟都不會清掉；放在外掛自己的 store（`$.store`，Claude Code 設定目錄下 `plugins/store/` 裡的一個 JSON 檔）。每條含 `id`、`text`、`created_at`、`repo`（git 頂層目錄名，worktree 取主工作樹；不在 git 裡取工作目錄最後一段）、`session`（`id` 與 `name`；API 沒有工作階段標題，`name` 為工作階段開始的日期時間）、`status`（`open` / `asked`）、`asked_at`。面板新增「待問」區塊（緊接「總結」，為空不顯示，`showParked` 可關）：依 repo → 工作階段 → 條目分組；目前的 repo 置頂並展開，其他 repo 收起並顯示條數；repo 內目前的工作階段展開，其他收起（顯示日期與條數）。每條一行（截斷）加時間，按鈕：`↵ 填入`（把文字放進輸入框，附加在已有草稿後，不送出）、`⧉ 複製`（純文字）、`✓ 已問`（標記並隱藏）、`✗ 刪除`；已問預設隱藏，repo 標題處可「顯示已問 (n)」，已問條目有「↺ 恢復」。對 Claude 說「把待問拿出來」，它會呼叫 `list_parked`；`update_parked` 用於改狀態 / 改文字 / 刪除。注意：store 檔依外掛安裝區分，同一外掛裝了兩份（如兩個 marketplace，或用 `--plugin-dir` 載入）會各有一份清單。
