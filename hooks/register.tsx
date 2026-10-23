import { atom, read, update } from 'claude-code'
import type { Register, RenderChildren, ToolCallResult } from 'claude-code'

import type { AgentRun, AgentRunStatus, LocalChange, SessionLink, Topic, TopicStatus } from '../types'

const PANE = 'task-tracker'
const TOPICS_TOOL: string = 'mcp__task-tracker__set_topics'
const SUMMARY_TOOL: string = 'mcp__task-tracker__set_agent_summary'
const SESSION_TOOL: string = 'mcp__task-tracker__set_session'

const topics = atom({ plugin: 'task-tracker', key: 'topics' } as const, [])
const now = atom({ plugin: 'task-tracker', key: 'now' } as const, '')
const updatedAt = atom({ plugin: 'task-tracker', key: 'updatedAt' } as const, '')
const expanded = atom({ plugin: 'task-tracker', key: 'expanded' } as const, [])
const agents = atom({ plugin: 'task-tracker', key: 'agents' } as const, [])
const summary = atom({ plugin: 'task-tracker', key: 'summary' } as const, '')
const testing = atom({ plugin: 'task-tracker', key: 'testing' } as const, [])
const created = atom({ plugin: 'task-tracker', key: 'created' } as const, [])
const merges = atom({ plugin: 'task-tracker', key: 'merges' } as const, [])
const changes = atom({ plugin: 'task-tracker', key: 'changes' } as const, [])
// Section ids the person flipped away from their default (Local changes defaults to folded, the rest to open)
const flipped = atom({ plugin: 'task-tracker', key: 'flipped' } as const, [])
const copied = atom({ plugin: 'task-tracker', key: 'copied' } as const, '')

const FOLDED_BY_DEFAULT = ['changes']

const AGENT_KEEP = 20

const AGENT_ICON: Record<AgentRunStatus, string> = {
  running: '🔄',
  done: '✅',
  aborted: '⛔',
  error: '❌',
}

const ICON: Record<TopicStatus, string> = {
  doing: '👉',
  waiting: '❓',
  blocked: '⏳',
  todo: '⬜',
  done: '✅',
}

const STATUSES: TopicStatus[] = ['doing', 'waiting', 'blocked', 'todo', 'done']

function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

function elapsed(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${m % 60}m`
}

// The terminal does not render Markdown: drop `code` / **bold** marks, keep only the last two segments of long paths (URLs untouched)
const LONG_PATH = /(?:[A-Za-z]:)?(?:[\\/][^\\/\s，。、；）)]+){3,}[\\/]?/g

function clean(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .split(/(\s+)/)
    .map(word =>
      word.includes('://')
        ? word
        : word.replace(LONG_PATH, path => `…/${path.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}`),
    )
    .join('')
}

const URL = /https?:\/\/[^\s)）】，。、；]+/g

// GitHub links show as a short name (repo#123); clicking opens the original link
function shortUrl(url: string): string {
  const gh = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/)
  if (gh) return `${gh[2]}#${gh[3]}`
  return url.replace(/^https?:\/\//, '').slice(0, 40)
}

type Segment = { text: string; href?: string }

function segments(text: string): Segment[] {
  const body = clean(text)
  const out: Segment[] = []
  let last = 0
  for (const match of body.matchAll(URL)) {
    const at = match.index ?? 0
    if (at > last) out.push({ text: body.slice(last, at) })
    out.push({ text: shortUrl(match[0]), href: match[0] })
    last = at + match[0].length
  }
  if (last < body.length) out.push({ text: body.slice(last) })
  return out
}

function strings(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const list = raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
  return list
}

function toLink(raw: unknown): SessionLink | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const url = typeof o.url === 'string' ? o.url.trim() : ''
  if (url === '') return undefined
  const label = typeof o.label === 'string' && o.label.trim() !== '' ? o.label.trim() : shortUrl(url)
  const link: SessionLink = { label, url }
  if (typeof o.note === 'string' && o.note.trim() !== '') link.note = o.note.trim()
  if (typeof o.kind === 'string' && o.kind.trim() !== '') link.kind = o.kind.trim()
  if (typeof o.topic === 'string' && o.topic.trim() !== '') link.topic = o.topic.trim()
  return link
}

// Merge by url: a repeated url replaces the old entry in place (so re-labelling works), new ones go last
function mergeLinks(list: SessionLink[], raw: unknown, remove: string[]): SessionLink[] {
  const incoming = (Array.isArray(raw) ? raw : []).map(toLink).filter((x): x is SessionLink => x !== undefined)
  const next = [...list]
  for (const link of incoming) {
    const at = next.findIndex(one => one.url === link.url)
    if (at < 0) next.push(link)
    else next[at] = link
  }
  return next.filter(one => !remove.includes(one.url))
}

function toChange(raw: unknown): LocalChange | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const label = typeof o.label === 'string' ? o.label.trim() : ''
  if (label === '') return undefined
  const change: LocalChange = { label }
  if (typeof o.detail === 'string' && o.detail.trim() !== '') change.detail = o.detail.trim()
  if (o.cleanup === true) change.cleanup = true
  return change
}

// Merge by label: a repeated label replaces the old entry in place
function mergeChanges(list: LocalChange[], raw: unknown, remove: string[]): LocalChange[] {
  const incoming = (Array.isArray(raw) ? raw : []).map(toChange).filter((x): x is LocalChange => x !== undefined)
  const next = [...list]
  for (const change of incoming) {
    const at = next.findIndex(one => one.label === change.label)
    if (at < 0) next.push(change)
    else next[at] = change
  }
  return next.filter(one => !remove.includes(one.label))
}

function toTopic(raw: unknown): Topic | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id.trim() : ''
  if (id === '') return undefined
  const topic: Topic = {
    id,
    title: typeof o.title === 'string' ? o.title : '',
    status: STATUSES.includes(o.status as TopicStatus) ? (o.status as TopicStatus) : 'todo',
  }
  if (typeof o.line === 'string' && o.line) topic.line = o.line
  if (typeof o.background === 'string' && o.background) topic.background = o.background
  for (const key of ['decided', 'outputs', 'pending', 'asks'] as const) {
    const list = strings(o[key])
    if (list !== undefined) topic[key] = list
  }
  return topic
}

// Merge by id: given fields overwrite, omitted ones are kept; new topics go last
function merge(list: Topic[], incoming: Topic[], raw: Record<string, unknown>[]): Topic[] {
  const next = [...list]
  incoming.forEach((topic, i) => {
    const at = next.findIndex(one => one.id === topic.id)
    if (at < 0) {
      next.push(topic)
      return
    }
    const old = next[at] as Topic
    const given = raw[i] ?? {}
    const merged: Topic = { ...old, status: 'status' in given ? topic.status : old.status }
    if ('title' in given && topic.title) merged.title = topic.title
    for (const key of ['line', 'background', 'decided', 'outputs', 'pending', 'asks'] as const) {
      if (!(key in given)) continue
      const value = topic[key]
      if (value === undefined || (Array.isArray(value) && value.length === 0)) delete merged[key]
      else (merged as Record<string, unknown>)[key] = value
    }
    next[at] = merged
  })
  return next
}

// On /compact, hand the board to the summary so the compacted conversation still has the topic record
function boardText(
  title: string,
  list: Topic[],
  runs: AgentRun[],
  session: { summary: string; testing: SessionLink[]; created: SessionLink[]; merges: SessionLink[]; changes: LocalChange[] },
): string {
  const lines = [
    `[${title} pane (task-tracker)] This is the record of this session's topics; the pane survives compaction. In the summary, keep every topic below in full: status, what was decided, outputs and what is left. Before continuing, align with it, and update it with set_topics / set_session when things change.`,
  ]
  for (const t of list) {
    lines.push(`- [${t.id}] ${t.title} (${t.status})${t.line ? `: ${t.line}` : ''}`)
    if (t.background) lines.push(`  Background: ${t.background}`)
    for (const d of t.decided ?? []) lines.push(`  Decided: ${d}`)
    for (const o of t.outputs ?? []) lines.push(`  Output: ${o}`)
    for (const p of t.pending ?? []) lines.push(`  Pending: ${p}`)
    for (const a of t.asks ?? []) lines.push(`  Ask: ${a}`)
    for (const run of runs.filter(r => r.topic === t.id && r.summary?.length)) {
      lines.push(`  agent "${run.description}": ${(run.summary ?? []).join('; ')}`)
    }
  }
  if (session.summary !== '') lines.push(`Session summary: ${session.summary}`)
  for (const t of session.testing) lines.push(`Testing: ${t.label} ${t.url}${t.note ? ` (${t.note})` : ''}`)
  for (const c of session.created) lines.push(`Created${c.kind ? ` ${c.kind}` : ''}: ${c.label} ${c.url}`)
  for (const m of session.merges) lines.push(`Awaiting merge: ${m.label} ${m.url}${m.topic ? ` (topic ${m.topic})` : ''}`)
  for (const c of session.changes) {
    lines.push(`Local change${c.cleanup ? ' (to clean up)' : ''}: ${c.label}${c.detail ? ` - ${c.detail}` : ''}`)
  }
  return lines.join('\n')
}

const LABELS = {
  en: {
    opened: 'Pane opened.',
    noAgent: (key: string) => `No agent whose description contains "${key}"; nothing updated`,
    recorded: (name: string, n: number) => `Recorded ${n} result point(s) for "${name}"`,
    updated: (n: number, total: number) => `Updated ${n} topic(s); ${total} on the pane`,
    toolCalls: (n: number) => `${n} tool call(s)`,
    running: 'Running…',
    noResult: 'No result recorded yet',
    background: 'background',
    stats: (n: number, done: number) => `This session · ${n} topic(s) · ${done} done`,
    updatedAt: (t: string) => ` · updated ${t}`,
    empty: 'No topics yet.',
    needsYou: 'Needs you',
    topics: 'Topics',
    summary: 'Summary',
    testing: 'Testing',
    created: 'Created',
    merges: 'Awaiting merge',
    changes: 'Local changes',
    copy: 'copy',
    copyAll: 'copy all',
    copiedMark: 'Copied',
    copyFailed: 'Copy failed',
    cleanup: 'CLEAN UP',
    sessionUpdated: (t: number, c: number, m: number, k: number) =>
      `Session updated; ${t} testing, ${c} created, ${m} awaiting merge, ${k} local change(s)`,
    otherAgents: 'Other agents',
    now: '  <- now',
    line: 'Now ',
    bg: 'Background ',
    decided: 'Decided',
    outputs: 'Outputs',
    pending: 'Pending',
    asks: 'Asks',
    hint: 'Click ▸ to expand a topic · click a question under "Needs you" to jump to its topic',
  },
  zh: {
    opened: '面板已打开。',
    noAgent: (key: string) => `没有找到描述含「${key}」的 agent，未更新`,
    recorded: (name: string, n: number) => `已记录「${name}」的结果 ${n} 条`,
    updated: (n: number, total: number) => `已更新 ${n} 个话题，面板共 ${total} 个`,
    toolCalls: (n: number) => `${n} 次工具`,
    running: '进行中…',
    noResult: '还没整理结果',
    background: '后台',
    stats: (n: number, done: number) => `本会话 · ${n} 个话题 · ${done} 个完成`,
    updatedAt: (t: string) => ` · ${t} 更新`,
    empty: '还没有话题。',
    needsYou: '等你',
    topics: '话题',
    summary: '总结',
    testing: '测试中',
    created: '已创建',
    merges: '等合并',
    changes: '本机改动',
    copy: '复制',
    copyAll: '全部复制',
    copiedMark: '已复制',
    copyFailed: '复制失败',
    cleanup: '待清理',
    sessionUpdated: (t: number, c: number, m: number, k: number) =>
      `会话信息已更新；测试中 ${t} 条，已创建 ${c} 条，等合并 ${m} 条，本机改动 ${k} 条`,
    otherAgents: '其他 Agent',
    now: '  ← 现在',
    line: '现在 ',
    bg: '背景 ',
    decided: '定了',
    outputs: '产出',
    pending: '还差',
    asks: '问你',
    hint: '点 ▸ 展开话题 · 点「等你」里的问题跳到那个话题',
  },
  'zh-TW': {
    opened: '面板已開啟。',
    noAgent: (key: string) => `找不到描述含「${key}」的 agent，未更新`,
    recorded: (name: string, n: number) => `已記錄「${name}」的結果 ${n} 條`,
    updated: (n: number, total: number) => `已更新 ${n} 個話題，面板共 ${total} 個`,
    toolCalls: (n: number) => `${n} 次工具`,
    running: '進行中…',
    noResult: '還沒整理結果',
    background: '背景執行',
    stats: (n: number, done: number) => `本工作階段 · ${n} 個話題 · ${done} 個完成`,
    updatedAt: (t: string) => ` · ${t} 更新`,
    empty: '還沒有話題。',
    needsYou: '等你',
    topics: '話題',
    summary: '總結',
    testing: '測試中',
    created: '已建立',
    merges: '等合併',
    changes: '本機變更',
    copy: '複製',
    copyAll: '全部複製',
    copiedMark: '已複製',
    copyFailed: '複製失敗',
    cleanup: '待清理',
    sessionUpdated: (t: number, c: number, m: number, k: number) =>
      `工作階段資訊已更新；測試中 ${t} 條，已建立 ${c} 條，等合併 ${m} 條，本機變更 ${k} 條`,
    otherAgents: '其他 Agent',
    now: '  ← 現在',
    line: '現在 ',
    bg: '背景 ',
    decided: '已決定',
    outputs: '產出',
    pending: '還差',
    asks: '問你',
    hint: '點 ▸ 展開話題 · 點「等你」裡的問題跳到該話題',
  },
}

// Every language must define exactly the keys of `en`; a missing key fails the type check.
type Labels = typeof LABELS.en
const _labelsCheck: Record<'zh' | 'zh-TW', Labels> = LABELS
void _labelsCheck

const LABEL_SETS: Record<string, Labels> = {
  en: LABELS.en,
  zh: LABELS.zh,
  'zh-CN': LABELS.zh,
  'zh-TW': LABELS['zh-TW'],
}

export const register: Register = (on, options) => {
  const TITLE = typeof options.title === 'string' && options.title.trim() !== '' ? options.title.trim() : 'Task Tracker'
  const L = (typeof options.uiLanguage === 'string' && LABEL_SETS[options.uiLanguage]) || LABELS.en
  const asksOnTop = options.asksOnTop !== false
  const showSummary = options.showSummary !== false
  const language = typeof options.language === 'string' ? options.language.trim() : ''
  const writeIn = language !== '' ? language : 'the language the user converses in (follow the user)'

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'set_topics',
      description:
        `Keep the "${TITLE}" side pane, the record of THIS session: one card per topic the user and you worked on ` +
        '(only this session\'s work, not later follow-ups or other sessions). The user reads it instead of scrolling back, ' +
        'so update a card whenever its topic moves: something was decided, produced, asked, or finished. ' +
        'Cards merge by id: pass only the topics that changed, and only the fields that changed (a given field replaces ' +
        'the old one; an empty list clears it). Fields: id (short, stable, e.g. "3"), title, status ' +
        '(doing = you work on it now | waiting = needs the user: a question or a merge | blocked = waits on someone else | ' +
        'todo | done), line (one short line: where it stands now), background (one or two sentences: what it is about), ' +
        'decided[] (decisions made, with who chose), outputs[] (what was produced: issue / PR / comment / file / page, ' +
        'with the full URL so it is clickable), pending[] (what is still left), asks[] (questions the user must answer; ' +
        'they are collected at the top of the pane). One open question = one card: when a topic spawns several things the ' +
        'user must decide, give each its own card whose background says what it is and why it needs deciding (with links), ' +
        'and whose asks[] holds the full question with options and your recommendation; keep a separate overview card for ' +
        'the whole topic instead of piling short asks onto it. When the question changes (a new draft, a new option), ' +
        'update that card\'s asks[] so no stale question stays on top. ' +
        'now: the id of the topic being worked on (new agents are filed under it). ' +
        'Plan steps with codes (P0, A1, B2...): wherever a code appears write "code name" (e.g. "A2 board and write scope moved to config"), ' +
        'never the bare code. A plan-type topic (a multi-step project) gets one overview card whose pending[] / outputs[] ' +
        'list ALL steps one per line as "code name: status", so the user can match the codes in your replies to the pane. ' +
        `Write everything in ${writeIn}, each line short; never use circled digits.`,
      inputSchema: {
        type: 'object',
        properties: {
          topics: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string', enum: STATUSES },
                line: { type: 'string' },
                background: { type: 'string' },
                decided: { type: 'array', items: { type: 'string' } },
                outputs: { type: 'array', items: { type: 'string' } },
                pending: { type: 'array', items: { type: 'string' } },
                asks: { type: 'array', items: { type: 'string' } },
              },
              required: ['id'],
            },
          },
          now: { type: 'string', description: 'Id of the topic being worked on now' },
          remove: { type: 'array', items: { type: 'string' }, description: 'Ids of cards to delete' },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'set_agent_summary',
      description:
        'After a subagent you launched finishes and you have read its report, record what it DELIVERED as 2-5 short ' +
        `result points (in ${writeIn}): the files / issues / pages it produced (full URLs) and the key findings — ` +
        `results only, not its steps. Shown under its topic card in the "${TITLE}" pane. ` +
        'agent: the description you gave the Agent tool (a substring is enough). topic: the topic id, if it should move.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'The Agent description, or a distinctive substring of it' },
          points: { type: 'array', items: { type: 'string' }, description: '2-5 result points' },
          topic: { type: 'string', description: 'Topic id to file the agent under' },
        },
        required: ['agent', 'points'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'set_session',
      description:
        `Keep the session-level part of the "${TITLE}" side pane: what belongs to the whole session rather than to one topic. ` +
        'Shown as separate sections next to the topics. ' +
        'summary: short text (a few lines) on where the session stands: what got done and what is still left; when given it replaces the old one, so rewrite it as the session moves on. ' +
        'testing[]: URLs the user is asked to test right now ({label, url, note?}); whenever you start a preview or test environment for the user to try, add its URL, and remove it (untest_urls) once testing is over. ' +
        'created[]: links to things created in this session ({label, url, kind?} with kind such as issue, pr, page); whenever you create an issue, PR or page, add its full URL right after. ' +
        'merges[]: pull requests opened in this session that still wait for the user to merge ({label, url, topic?} with topic the id of the owning topic); add one when you open a PR, and remove it from the awaiting-merge list with merged_urls once the user says it is merged (it stays under created). ' +
        'changes[]: changes left on the user\'s machine that outlive the session ({label, detail?, cleanup?}): a registered scheduled task, an environment variable set, an account or credential switched, a deployed service (detail: version or commit), a memory written, and so on; ' +
        'record one whenever you make such a change, set cleanup: true on temporary leftovers that still have to be cleaned up (temporary worktree or branch, test session, temporary directory) so they stand out, and remove the entry (remove_labels) once it is cleaned up or no longer applies. ' +
        'testing, created and merges entries merge by url, changes entries by label (a repeat replaces the old entry); untest_urls[] deletes entries from testing only; merged_urls[] deletes entries from merges only (the user said the PR is merged); remove_urls[] deletes entries from testing, created and merges all at once, generally for entries added by mistake; remove_labels[] deletes entries from changes. ' +
        'Pass only what changed. ' +
        `Write labels, notes and the summary in ${writeIn}, each line short; never use circled digits.`,
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Session summary; replaces the old one' },
          testing: {
            type: 'array',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, url: { type: 'string' }, note: { type: 'string' } },
              required: ['url'],
            },
          },
          created: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                url: { type: 'string' },
                kind: { type: 'string', description: 'e.g. issue, pr, page' },
              },
              required: ['url'],
            },
          },
          merges: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                url: { type: 'string' },
                topic: { type: 'string', description: 'Id of the owning topic' },
              },
              required: ['url'],
            },
          },
          changes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                detail: { type: 'string' },
                cleanup: { type: 'boolean', description: 'true: still to be cleaned up' },
              },
              required: ['label'],
            },
          },
          remove_urls: { type: 'array', items: { type: 'string' }, description: 'URLs to delete from testing, created and merges all at once; generally for entries added by mistake' },
          untest_urls: { type: 'array', items: { type: 'string' }, description: 'URLs to delete from testing only (testing is over)' },
          merged_urls: { type: 'array', items: { type: 'string' }, description: 'URLs to delete from merges only (the user said the PR is merged); created keeps them' },
          remove_labels: { type: 'array', items: { type: 'string' }, description: 'Labels to delete from changes' },
        },
      },
      isDeferred: false,
    })
    await $.command.register({ name: 'tracker', description: `Open the "${TITLE}" pane` })

    return next(e)
  })

  on('command.run', { command: 'tracker' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: L.opened }
  })

  // /compact: the pane stays, and its content goes to the summary
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    try {
      const list = await read($, topics)
      const session = {
        summary: await read($, summary),
        testing: await read($, testing),
        created: await read($, created),
        merges: await read($, merges),
        changes: await read($, changes),
      }
      const hasSession =
        session.summary !== '' ||
        session.testing.length + session.created.length + session.merges.length + session.changes.length > 0
      if (list.length === 0 && !hasSession) return next(e)
      const text = boardText(TITLE, list, await read($, agents), session)
      return next({ ...e, instructions: [e.instructions, text].filter(Boolean).join('\n\n') })
    } catch {
      return next(e)
    }
  })

  // /clear: new work, the pane is emptied
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      try {
        await update($, topics, () => [])
        await update($, agents, () => [])
        await update($, expanded, () => [])
        await update($, flipped, () => [])
        await update($, copied, () => '')
        await update($, now, () => '')
        await update($, summary, () => '')
        await update($, testing, () => [])
        await update($, created, () => [])
        await update($, merges, () => [])
        await update($, changes, () => [])
        await update($, updatedAt, () => '')
      } catch {
        // display only
      }
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined) return result
    try {
      const topic = await read($, now)
      const run: AgentRun = {
        key: e.tool_use_id || `${Date.now()}`,
        description: e.description,
        type: e.subagentType,
        model: shortModel(result.model),
        background: e.background,
        startedAt: Date.now(),
        status: 'running',
        tools: 0,
      }
      if (topic !== '') run.topic = topic
      if (result.agentId !== undefined) run.agentId = result.agentId
      await update($, agents, list => [...list, run].slice(-AGENT_KEEP))
      void $.ui.open({ id: PANE, title: TITLE })
    } catch {
      // display only: a failed record must not block the agent
    }

    return result
  })

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId !== undefined) {
      try {
        await update($, agents, list =>
          list.map(run =>
            run.agentId === agentId && run.status === 'running'
              ? { ...run, tools: run.tools + 1, lastTool: e.tool.replace(/^mcp__.+__/, '') }
              : run,
          ),
        )
      } catch {
        // display only: a failed count must not block the tool call
      }
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId !== undefined) {
      const status: AgentRunStatus = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'aborted' : 'error'
      try {
        await update($, agents, list =>
          list.map(run =>
            run.agentId === agentId && run.status === 'running'
              ? { ...run, status, endedAt: Date.now(), report: e.answer }
              : run,
          ),
        )
      } catch {
        // display only
      }
    }

    return next(e)
  })

  on('tool.call', { tool: SUMMARY_TOOL }, async ($, e): Promise<ToolCallResult> => {
    const input = e as unknown as { agent?: unknown; points?: unknown; topic?: unknown }
    const key = typeof input.agent === 'string' ? input.agent.trim() : ''
    const points = (strings(input.points) ?? []).slice(0, 6)
    const topic = typeof input.topic === 'string' ? input.topic.trim() : ''
    let matched = ''
    await update($, agents, list => {
      const idx = [...list].reverse().findIndex(run => key !== '' && run.description.includes(key))
      if (idx < 0) return list
      const real = list.length - 1 - idx
      matched = list[real]?.description ?? ''
      return list.map((run, i) => (i === real ? { ...run, summary: points, ...(topic ? { topic } : {}) } : run))
    })
    if (matched === '') return { result: L.noAgent(key) }
    void $.ui.open({ id: PANE, title: TITLE })

    return { result: L.recorded(matched, points.length) }
  })

  on('tool.call', { tool: SESSION_TOOL }, async ($, e): Promise<ToolCallResult> => {
    const input = e as unknown as {
      summary?: unknown
      testing?: unknown
      created?: unknown
      merges?: unknown
      changes?: unknown
      remove_urls?: unknown
      untest_urls?: unknown
      merged_urls?: unknown
      remove_labels?: unknown
    }
    const remove = strings(input.remove_urls) ?? []
    const untest = strings(input.untest_urls) ?? []
    const merged = strings(input.merged_urls) ?? []
    const removeLabels = strings(input.remove_labels) ?? []
    const clock = new Date()
    const stamp = `${String(clock.getHours()).padStart(2, '0')}:${String(clock.getMinutes()).padStart(2, '0')}`
    if (typeof input.summary === 'string') await update($, summary, () => (input.summary as string).trim())
    let t = 0
    let c = 0
    let m = 0
    let k = 0
    await update($, testing, list => {
      const next = mergeLinks(list, input.testing, [...remove, ...untest])
      t = next.length
      return next
    })
    await update($, created, list => {
      const next = mergeLinks(list, input.created, remove)
      c = next.length
      return next
    })
    await update($, merges, list => {
      const next = mergeLinks(list, input.merges, [...remove, ...merged])
      m = next.length
      return next
    })
    await update($, changes, list => {
      const next = mergeChanges(list, input.changes, removeLabels)
      k = next.length
      return next
    })
    await update($, updatedAt, () => stamp)
    void $.ui.open({ id: PANE, title: TITLE })

    return { result: L.sessionUpdated(t, c, m, k) }
  })

  on('tool.call', { tool: TOPICS_TOOL }, async ($, e): Promise<ToolCallResult> => {
    const input = e as unknown as { topics?: unknown; now?: unknown; remove?: unknown }
    const raw = Array.isArray(input.topics)
      ? input.topics.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      : []
    const pairs = raw.map(one => [one, toTopic(one)] as const).filter(pair => pair[1] !== undefined)
    const remove = strings(input.remove) ?? []
    const clock = new Date()
    const stamp = `${String(clock.getHours()).padStart(2, '0')}:${String(clock.getMinutes()).padStart(2, '0')}`
    let total = 0
    await update($, topics, list => {
      const next = merge(
        list,
        pairs.map(pair => pair[1] as Topic),
        pairs.map(pair => pair[0]),
      ).filter(one => !remove.includes(one.id))
      total = next.length
      return next
    })
    if (typeof input.now === 'string') await update($, now, () => (input.now as string).trim())
    await update($, updatedAt, () => stamp)
    void $.ui.open({ id: PANE, title: TITLE })

    return { result: L.updated(pairs.length, total) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const list = await read($, topics)
    const current = await read($, now)
    const stamp = await read($, updatedAt)
    const open = await read($, expanded)
    const runs = await read($, agents)
    const sessionSummary = await read($, summary)
    const testingList = await read($, testing)
    const createdList = await read($, created)
    const mergeList = await read($, merges)
    const changeList = await read($, changes)
    const flips = await read($, flipped)
    const copiedKey = await read($, copied)
    const clock = Date.now()

    const toggle = (id: string) => () =>
      update($, expanded, ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]))
    const isFolded = (id: string) => FOLDED_BY_DEFAULT.includes(id) !== flips.includes(id)
    const flip = (id: string) => () =>
      update($, flipped, ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]))
    const copyText = (key: string, text: string) => async (press: { surface: string }) => {
      const res = await $.ui.copy({ text, surface: press.surface as never })
      await update($, copied, () => (res.isCopied ? key : `!${key}`))
      $.clock.after(1500, () => {
        void update($, copied, cur => (cur === key || cur === `!${key}` ? '' : cur))
      })
    }
    const copyMark = (key: string) =>
      copiedKey === key ? ` ✓ ${L.copiedMark}` : copiedKey === `!${key}` ? ` ✗ ${L.copyFailed}` : ''
    const reveal = (id: string) => () => update($, expanded, ids => (ids.includes(id) ? ids : [...ids, id]))

    const rich = (text: string, color?: string) => (
      <Text color={color}>
        {segments(text).map(seg => (seg.href ? <Link href={seg.href}>{seg.text}</Link> : seg.text))}
      </Text>
    )
    const hang = (mark: string, color: string, text: string, bodyColor?: string) => (
      <Box flexDirection="row">
        <Text color={color}>{mark}</Text>
        <Box flexShrink={1}>{rich(text, bodyColor)}</Box>
      </Box>
    )
    const section = (label: string, count: number) => (
      <Box marginTop={1}>
        <Text color="claude" bold>
          ━ {label} ({count})
        </Text>
      </Box>
    )
    // Session-level section header: click to fold; the count stays visible; extra is an optional action button
    const fold = (id: string, label: string, count: number, extra?: RenderChildren) => (
      <Box marginTop={1} flexDirection="row">
        <Button
          key={`fold-${id}`}
          plain
          label={`${isFolded(id) ? '▸' : '▾'} ━ ${label} (${count})`}
          onPress={flip(id)}
        />
        {extra}
      </Box>
    )
    const group = (label: string, color: string, lines: string[] | undefined, mark = '• ') =>
      lines !== undefined && lines.length > 0 ? (
        <Box flexDirection="column">
          <Text color={color} bold>
            {label}
          </Text>
          {lines.map(line => hang(mark, 'subtle', line))}
        </Box>
      ) : null

    const agentRow = (run: AgentRun, indent: number) => {
      const id = `agent-${run.key}`
      const isOpen = open.includes(id)
      const time = elapsed(run.startedAt, run.endedAt ?? clock)
      const busy = run.status === 'running' ? ` · ${L.toolCalls(run.tools)}${run.lastTool ? ` (${run.lastTool})` : ''}` : ''
      return (
        <Box key={id} flexDirection="column" marginLeft={indent}>
          <Button
            key={`toggle-${id}`}
            plain
            dimColor={run.status === 'done' && !isOpen}
            label={`${isOpen ? '▾' : '▸'} 🤖 ${AGENT_ICON[run.status]} ${run.description} · ${time}${busy}`}
            onPress={toggle(id)}
          />
          {isOpen && (
            <Box flexDirection="column" marginLeft={4}>
              {run.status === 'running' && <Text dimColor>{L.running}</Text>}
              {run.summary !== undefined && run.summary.length > 0
                ? run.summary.map(point => hang('• ', 'success', point))
                : run.status !== 'running' && <Text dimColor>{L.noResult}</Text>}
              <Text dimColor>
                {run.type} · {run.model}
                {run.background ? ` · ${L.background}` : ''}
              </Text>
            </Box>
          )}
        </Box>
      )
    }

    const asks = list.flatMap(t =>
      t.status === 'done' ? [] : (t.asks ?? []).map(ask => ({ topic: t, ask })),
    )
    const order: TopicStatus[] = ['doing', 'waiting', 'blocked', 'todo', 'done']
    const sorted = [...list].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))
    const loose = runs.filter(run => run.topic === undefined || !list.some(t => t.id === run.topic))
    const done = list.filter(t => t.status === 'done').length

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {L.stats(list.length, done)}
          {stamp ? L.updatedAt(stamp) : ''}
        </Text>
        {list.length === 0 && sessionSummary === '' && testingList.length + createdList.length + mergeList.length + changeList.length === 0 && (
          <Text dimColor>{L.empty}</Text>
        )}

        {asksOnTop && asks.length > 0 && section(L.needsYou, asks.length)}
        {(asksOnTop ? asks : []).map(({ topic, ask }, i) => (
          <Box key={`ask-${i}`} flexDirection="column">
            <Button
              key={`ask-btn-${i}`}
              plain
              label={`? ${clean(ask)}`}
              onPress={reveal(topic.id)}
            />
            <Text dimColor>
              {'    '}← {topic.id}. {topic.title}
            </Text>
          </Box>
        ))}

        {mergeList.length > 0 && fold('merges', L.merges, mergeList.length)}
        {(isFolded('merges') ? [] : mergeList).map(item => {
          const owner = item.topic !== undefined ? list.find(x => x.id === item.topic) : undefined
          return (
            <Box key={`merge-${item.url}`} flexDirection="row">
              <Text color="warning">⏳ </Text>
              <Box flexShrink={1}>
                <Text>
                  <Link href={item.url}>{clean(item.label)}</Link>
                  {owner ? ` · ← ${owner.id}. ${clean(owner.title)}` : ''}
                </Text>
              </Box>
            </Box>
          )
        })}

        {showSummary && sessionSummary !== '' && fold('summary', L.summary, sessionSummary.split('\n').filter(x => x.trim() !== '').length)}
        {showSummary && sessionSummary !== '' && !isFolded('summary') && rich(sessionSummary)}

        {testingList.length > 0 && fold('testing', L.testing, testingList.length)}
        {(isFolded('testing') ? [] : testingList).map(item => (
          <Box key={`testing-${item.url}`} flexDirection="row">
            <Text color="warning">🧪 </Text>
            <Box flexShrink={1}>
              <Text>
                <Link href={item.url}>{clean(item.label)}</Link>
                {item.note ? ` · ${clean(item.note)}` : ''}
              </Text>
            </Box>
          </Box>
        ))}

        {createdList.length > 0 &&
          fold(
            'created',
            L.created,
            createdList.length,
            !isFolded('created') && (
              <Button
                key="copy-created-all"
                plain
                dimColor
                label={` ⧉ ${L.copyAll}${copyMark('created-all')}`}
                onPress={copyText('created-all', createdList.map(i => `- [${clean(i.label)}](${i.url})`).join('\n'))}
              />
            ),
          )}
        {(isFolded('created') ? [] : createdList).map(item => (
          <Box key={`created-${item.url}`} flexDirection="row">
            <Text color="success">• </Text>
            <Box flexShrink={1}>
              <Text>
                {item.kind ? `${item.kind} · ` : ''}
                <Link href={item.url}>{clean(item.label)}</Link>
              </Text>
            </Box>
            <Button
              key={`copy-created-${item.url}`}
              plain
              dimColor
              label={` ⧉ ${L.copy}${copyMark(`created-${item.url}`)}`}
              onPress={copyText(`created-${item.url}`, `[${clean(item.label)}](${item.url})`)}
            />
          </Box>
        ))}

        {changeList.length > 0 && fold('changes', L.changes, changeList.length)}
        {(isFolded('changes') ? [] : changeList).map(item => (
          <Box key={`change-${item.label}`} flexDirection="row">
            <Text color={item.cleanup ? 'warning' : 'subtle'}>{item.cleanup ? '🧹 ' : '• '}</Text>
            <Box flexShrink={1}>
              <Text>
                {item.cleanup ? <Text color="warning" bold>[{L.cleanup}] </Text> : ''}
                {clean(item.label)}
                {item.detail ? ` · ${clean(item.detail)}` : ''}
              </Text>
            </Box>
          </Box>
        ))}

        {list.length > 0 && section(L.topics, list.length)}
        {sorted.map(t => {
          const isOpen = open.includes(t.id)
          const mine = runs.filter(run => run.topic === t.id)
          const running = mine.filter(run => run.status === 'running').length
          const badge = mine.length > 0 ? ` · 🤖${running > 0 ? `${running}/` : ''}${mine.length}` : ''
          const isNow = t.id === current && t.status !== 'done'
          return (
            <Box key={`topic-${t.id}`} flexDirection="column">
              <Button
                key={`toggle-${t.id}`}
                plain
                dimColor={t.status === 'done' && !isOpen}
                label={`${isOpen ? '▾' : '▸'} ${ICON[t.status]} ${t.id}. ${clean(t.title)}${badge}${isNow ? L.now : ''}`}
                onPress={toggle(t.id)}
              />
              {t.line !== undefined && !isOpen && (
                <Box marginLeft={4}>{rich(t.line, t.status === 'done' ? 'subtle' : undefined)}</Box>
              )}
              {isOpen && (
                <Box flexDirection="column" marginLeft={4} marginBottom={1}>
                  {t.line !== undefined && hang(L.line, 'claude', t.line)}
                  {t.background !== undefined && hang(L.bg, 'subtle', t.background)}
                  {group(L.decided, 'success', t.decided)}
                  {group(L.outputs, 'success', t.outputs)}
                  {group(L.pending, 'warning', t.pending)}
                  {group(L.asks, 'warning', t.asks, '? ')}
                  {mine.map(run => agentRow(run, 0))}
                </Box>
              )}
            </Box>
          )
        })}

        {loose.length > 0 && section(L.otherAgents, loose.length)}
        {loose.map(run => agentRow(run, 0))}

        {list.length > 0 && (
          <Box marginTop={1}>
            <Text dimColor>{L.hint}</Text>
          </Box>
        )}
      </Box>
    )
  })
}
