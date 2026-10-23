# task-tracker

A Claude Code plugin that keeps a **side pane recording the current session**: what was discussed, decided, produced and is still pending, so you do not have to scroll back through the chat. When you work on several things at once, each one is a collapsible card.

## What the pane shows

- **Needs you** (pinned on top): every open question across all cards, each tagged with its card. Click one to expand that card. Can be turned off (see Configuration).
- **Awaiting merge** (right below Needs you): pull requests opened this session that still wait for you to merge, clickable, tagged with their topic when one is given. Claude adds one when it opens a PR and removes it once you say it is merged.
- **Summary**: a few lines on where the session stands (what got done, what is left), rewritten by Claude as work moves on. Can be turned off (`showSummary`).
- **Testing**: URLs you are asked to test right now (preview or test environments), clickable, each with an optional note. Removed once testing is over.
- **Created**: links to things created this session (issues, PRs, pages), clickable.
- **Local changes**: changes left on your machine that outlive the session: a registered scheduled task, an environment variable, a switched account, a deployed service (with version), a written memory. Temporary leftovers (worktree, branch, test session, temp directory) are flagged `CLEAN UP` and removed once cleaned.
- **Topics**: one card per thing worked on this session, sorted 👉 doing / ❓ needs you / ⏳ waiting on others / ⬜ todo / ✅ done. Collapsed it is one line (title + where it stands); expanded it shows: now, background, decided, outputs (GitHub links are clickable and shown as `repo#123`), pending, asks, and the subagents launched for that topic.
- **Agents**: a subagent you launch is filed under the current topic (marked "now"); while running it shows elapsed time and tool-call count, and once finished you can expand the result summary Claude wrote. Agents without a topic are listed under "Other agents".

Session-level sections (Awaiting merge, Summary, Testing, Created, Local changes) fold: click the header (`▾` / `▸`) to collapse or expand; the header keeps showing the item count, e.g. `Local changes (7)`. Local changes starts folded, the others start open; the choice is kept in the session state (reset by `/clear`). Needs you and the topic cards are unchanged.

In **Created**, every row has a `⧉ copy` button that puts `label — url` on the clipboard, and the header has `⧉ copy all`, which copies every entry as a Markdown list (`- [label](url)`, one per line). The button briefly shows `✓ Copied` (or `✗ Copy failed` when no clipboard was reachable, e.g. a remote surface). Copying uses the host's `$.ui.copy` (the terminal's clipboard tool / OSC 52).

Session-level sections (Summary, Testing, Created) belong to the whole session, not to a topic, and are hidden while empty. Top to bottom: Needs you, Awaiting merge, Summary, Testing, Created, Local changes, Topics, Other agents.

The pane opens by itself the first time it has content; reopen it with `/tracker`.

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
| `uiLanguage` | `en` | Language of the fixed pane labels: `en` or `zh`. |
| `asksOnTop` | `true` | Show the "Needs you" section on top. |
| `showSummary` | `true` | Show the session Summary section. |

## Tools Claude uses

| Tool | Purpose |
|---|---|
| `mcp__task-tracker__set_topics` | Merge-update cards by `id`: pass only the topics that changed and only the changed fields (an empty array clears a field). Fields: `title`, `status` (doing, waiting, blocked, todo, done), `line`, `background`, `decided[]`, `outputs[]`, `pending[]`, `asks[]`; plus `now` (id of the current topic) and `remove` (delete cards). |
| `mcp__task-tracker__set_agent_summary` | After a subagent finishes and its report is read, record what it delivered (2-5 points); can re-file it under another topic with `topic`. |
| `mcp__task-tracker__set_session` | Session-level record: `summary` (text, replaces the old one), `testing[]` (`{label, url, note?}`, URLs under test), `created[]` (`{label, url, kind?}`, issues / PRs / pages created), `merges[]` (`{label, url, topic?}`, PRs awaiting your merge), all merged by `url`; `changes[]` (`{label, detail?, cleanup?}`, local changes) merged by `label`; `remove_urls[]` / `remove_labels[]` delete entries. Claude is told to add a link right after creating an issue / PR / page, to add a PR to `merges` when it opens it and remove it when you merge, to list a preview URL while you test it and remove it afterwards, to record local changes (with `cleanup: true` for temporary leftovers) and remove them once cleaned, and to keep the summary current. |

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
- 配置（安装时或 `/config`）：`title` 面板标题（默认 Task Tracker，可填「事项总览」）；`language` 卡片写作语言（留空跟随对话，如填 `Simplified Chinese`）；`uiLanguage` 面板固定文字 `en` / `zh`；`asksOnTop` 是否置顶「等你」。
- 一个待定问题一张卡；计划步骤用代号时，凡出现代号都写「代号 名称」，计划类话题要有总览卡列出全部步骤「代号 名称：状态」。
- `/compact` 保留面板并把内容交给摘要；`/clear` 清空；新会话从空开始；只放本会话的事。
- 会话级三块（与「话题」同级、为空不显示）：「总结」（几行，做成了什么、还差什么）、「测试中」（正在测的 URL，可点）、「已创建」（本会话建的 issue / PR / 页面链接，可点）；由工具 `set_session` 写入，`showSummary` 可关总结。另有「等合并」（本会话开出、等你合的 PR，紧贴「等你」下方）与「本机改动」（会话后仍留在本机的定时任务 / 环境变量 / 账号 / 部署 / memory 等，临时 worktree / 分支 / 测试 session / 临时目录标「待清理」）。面板顺序：等你、等合并、总结、测试中、已创建、本机改动、话题。`/compact` 一并交给摘要，`/clear` 清空。
- 会话级区块（等合并、总结、测试中、已创建、本机改动）点标题（`▾` / `▸`）可收起 / 展开，标题后始终显示条数（如「本机改动 (7)」）；「本机改动」默认收起，其余默认展开；状态存在会话 state，`/clear` 重置；「等你」和话题卡片不变。「已创建」每行有「⧉ 复制」按钮（复制 `label — url`），标题处有「⧉ 全部复制」（每行 `- [label](url)` 的 Markdown 列表）；复制后短暂显示「✓ 已复制」。
- License：MIT。
