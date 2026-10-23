# task-tracker

A Claude Code plugin that keeps a **side pane recording the current session**: what was discussed, decided, produced and is still pending, so you do not have to scroll back through the chat. When you work on several things at once, each one is a collapsible card.

## What the pane shows

- **Needs you** (pinned on top): every open question across all cards, each tagged with its card. Click one to expand that card. Can be turned off (see Configuration).
- **Topics**: one card per thing worked on this session, sorted 👉 doing / ❓ needs you / ⏳ waiting on others / ⬜ todo / ✅ done. Collapsed it is one line (title + where it stands); expanded it shows: now, background, decided, outputs (GitHub links are clickable and shown as `repo#123`), pending, asks, and the subagents launched for that topic.
- **Agents**: a subagent you launch is filed under the current topic (marked "now"); while running it shows elapsed time and tool-call count, and once finished you can expand the result summary Claude wrote. Agents without a topic are listed under "Other agents".

The pane opens by itself the first time it has content; reopen it with `/tracker`.

## Session lifecycle

| When | Pane |
|---|---|
| `/compact` (manual or automatic) | kept, and the whole topic record is handed to the compaction summary so Claude realigns with it afterwards |
| `/clear` | emptied, new work starts |
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

## Tools Claude uses

| Tool | Purpose |
|---|---|
| `mcp__task-tracker__set_topics` | Merge-update cards by `id`: pass only the topics that changed and only the changed fields (an empty array clears a field). Fields: `title`, `status` (doing, waiting, blocked, todo, done), `line`, `background`, `decided[]`, `outputs[]`, `pending[]`, `asks[]`; plus `now` (id of the current topic) and `remove` (delete cards). |
| `mcp__task-tracker__set_agent_summary` | After a subagent finishes and its report is read, record what it delivered (2-5 points); can re-file it under another topic with `topic`. |

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
- License：MIT。
