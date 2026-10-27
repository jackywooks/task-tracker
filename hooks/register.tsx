import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, ToolCallResult } from 'claude-code'

import { groupLinks, groupedPayload, singlePayload, writeRich } from './clipboard'
import type { GroupNames, GroupedPayload } from './clipboard'

import { addParked, changeParked, groupParked, loadParked, stamp as parkedStamp, whereAmI } from './parked'
import type { Parked, ParkedStatus } from './parked'

import {
  RECORD_PREFIX,
  isEmptyData,
  loadRecords,
  pickFallback,
  pruneRecords,
  saveRecord,
  toRecord,
} from './persist'
import type { PaneData } from './persist'

import { applyMergeStates, askOptions, askText, checkPrs, fillMode, isPrUrl, optionReply } from './merges'

import type { AgentRun, AgentRunStatus, Ask, LocalChange, SessionLink, Topic, TopicStatus } from '../types'

const PANE = 'task-tracker'
const TOPICS_TOOL: string = 'mcp__task-tracker__set_topics'
const SUMMARY_TOOL: string = 'mcp__task-tracker__set_agent_summary'
const SESSION_TOOL: string = 'mcp__task-tracker__set_session'
const PARK_TOOL: string = 'mcp__task-tracker__park_prompt'
const LIST_PARKED_TOOL: string = 'mcp__task-tracker__list_parked'
const UPDATE_PARKED_TOOL: string = 'mcp__task-tracker__update_parked'

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
// Urls of awaiting-merge PRs that GitHub reports closed without merging (shown with a `closed` badge)
const closedMerges = atom({ plugin: 'task-tracker', key: 'closedMerges' } as const, [])
// Section ids the person flipped away from their default (Local changes defaults to folded, the rest to open)
const flipped = atom({ plugin: 'task-tracker', key: 'flipped' } as const, [])
const copied = atom({ plugin: 'task-tracker', key: 'copied' } as const, '')
// Parked prompts live in $.store (all repos, all sessions); this counter only redraws the pane after a write
const parkedTick = atom({ plugin: 'task-tracker', key: 'parkedTick' } as const, 0)
// Group ids the person flipped away from their default (current repo / session open, others folded; 'asked:<repo>' shows asked items)
const parkedFlipped = atom({ plugin: 'task-tracker', key: 'parkedFlipped' } as const, [])

// Pane persistence: when the pane was put back from the store ('' = it was not), whether the last write failed (store
// full), and the one record offered for a one-click restore when no record carries this session's id
const restoredNote = atom({ plugin: 'task-tracker', key: 'restoredNote' } as const, '')
const saveWarning = atom({ plugin: 'task-tracker', key: 'saveWarning' } as const, false)
const restoreOffer = atom({ plugin: 'task-tracker', key: 'restoreOffer' } as const, [])

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

// asks[] items are strings or {question, options: [{label, reply?}]}; a question without usable options stays a plain string
function toAsks(raw: unknown): Ask[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: Ask[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim() !== '') out.push(item)
      continue
    }
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const question = typeof o.question === 'string' ? o.question.trim() : ''
    if (question === '') continue
    const options = (Array.isArray(o.options) ? o.options : []).flatMap(opt => {
      if (!opt || typeof opt !== 'object') return []
      const r = opt as Record<string, unknown>
      const label = typeof r.label === 'string' ? r.label.trim() : ''
      if (label === '') return []
      const one: { label: string; reply?: string } = { label }
      if (typeof r.reply === 'string' && r.reply.trim() !== '') one.reply = r.reply.trim()
      return [one]
    })
    out.push(options.length > 0 ? { question, options } : question)
  }
  return out
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
  if (typeof o.parent === 'string' && o.parent.trim() !== '') link.parent = o.parent.trim()
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
  if (typeof o.path === 'string' && o.path.trim() !== '') change.path = o.path.trim()
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
  for (const key of ['decided', 'outputs', 'pending'] as const) {
    const list = strings(o[key])
    if (list !== undefined) topic[key] = list
  }
  const asks = toAsks(o.asks)
  if (asks !== undefined) topic.asks = asks
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
    for (const a of t.asks ?? []) {
      const opts = askOptions(a)
      lines.push(`  Ask: ${askText(a)}${opts.length > 0 ? ` [options: ${opts.map(x => x.label).join(' | ')}]` : ''}`)
    }
    for (const run of runs.filter(r => r.topic === t.id && r.summary?.length)) {
      lines.push(`  agent "${run.description}": ${(run.summary ?? []).join('; ')}`)
    }
  }
  if (session.summary !== '') lines.push(`Session summary: ${session.summary}`)
  for (const t of session.testing) lines.push(`Testing: ${t.label} ${t.url}${t.note ? ` (${t.note})` : ''}`)
  for (const c of session.created) lines.push(`Created${c.kind ? ` ${c.kind}` : ''}: ${c.label} ${c.url}${c.parent ? ` (under ${c.parent})` : ''}`)
  for (const m of session.merges) lines.push(`Awaiting merge: ${m.label} ${m.url}${m.topic ? ` (topic ${m.topic})` : ''}`)
  for (const c of session.changes) {
    lines.push(`Local change${c.cleanup ? ' (to clean up)' : ''}: ${c.label}${c.detail ? ` - ${c.detail}` : ''}${c.path ? ` [${c.path}]` : ''}`)
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
    restored: (t: string) => `Restored after a restart (saved ${t})`,
    restoreOffer: (t: string, n: number) => `Restore the last pane of this folder (saved ${t}, ${n} topic(s))`,
    saveFailed: '⚠ The pane could not be saved (plugin store full); it will be lost on restart',
    needsYou: 'Needs you',
    topics: 'Topics',
    summary: 'Summary',
    testing: 'Testing',
    created: 'Created',
    merges: 'Awaiting merge',
    changes: 'Local changes',
    copy: 'copy',
    copyAll: 'copy all',
    groupIssues: 'Issues',
    groupPrs: 'PRs',
    groupOther: 'Other',
    copyGroup: 'copy group',
    copiedMark: 'Copied',
    copiedRich: 'Copied (rich link)',
    copiedMd: 'Copied (Markdown)',
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
    parked: 'Parked prompts',
    parkedCount: (n: number) => `${n} parked`,
    parkedFill: 'fill',
    parkedCopy: 'copy',
    parkedAsked: 'asked',
    parkedReopen: 'reopen',
    parkedDelete: 'delete',
    parkedShowAsked: (n: number) => `show asked (${n})`,
    parkedHideAsked: (n: number) => `hide asked (${n})`,
    parkedCurrent: ' (current)',
    parkedCopied: '✓ Copied',
    parkedFilled: '✓ Put in the prompt box',
    parkedFillFailed: '✗ No prompt box to fill',
    parkedSaved: (n: number) => `Parked (${n} waiting). Ask later from the pane.`,
    parkedUsage: 'Usage: /park <text> — saves the text to ask later; nothing is sent to Claude.',
    parkedNone: 'No parked prompts.',
    parkedUnknown: (id: string) => `No parked prompt with id ${id}`,
    parkedUpdated: (what: string, id: string) => `Parked prompt ${id} ${what}`,
    cleanBtn: 'clean',
    cleanRequest: (label: string, where: string) => `Please clean up: ${label}${where ? ` (${where})` : ''}`,
    prMerged: (label: string) => `PR merged: ${label}`,
    prClosed: 'closed',
    putIn: '✓ Put in the prompt box',
    putCopied: '✓ Copied (no prompt box)',
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
    restored: (t: string) => `已在重启后恢复（保存于 ${t}）`,
    restoreOffer: (t: string, n: number) => `恢复此目录上次的面板（保存于 ${t}，${n} 个话题）`,
    saveFailed: '⚠ 面板无法保存（插件存储已满），重启后会丢失',
    needsYou: '等你',
    topics: '话题',
    summary: '总结',
    testing: '测试中',
    created: '已创建',
    merges: '等合并',
    changes: '本机改动',
    copy: '复制',
    copyAll: '全部复制',
    groupIssues: 'Issue',
    groupPrs: 'PR',
    groupOther: '其他',
    copyGroup: '复制本组',
    copiedMark: '已复制',
    copiedRich: '已复制（富链接）',
    copiedMd: '已复制（Markdown）',
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
    parked: '待问',
    parkedCount: (n: number) => `${n} 条待问`,
    parkedFill: '填入',
    parkedCopy: '复制',
    parkedAsked: '已问',
    parkedReopen: '恢复',
    parkedDelete: '删除',
    parkedShowAsked: (n: number) => `显示已问 (${n})`,
    parkedHideAsked: (n: number) => `隐藏已问 (${n})`,
    parkedCurrent: '（当前）',
    parkedCopied: '✓ 已复制',
    parkedFilled: '✓ 已填入输入框',
    parkedFillFailed: '✗ 没有可填的输入框',
    parkedSaved: (n: number) => `已存入待问（共 ${n} 条未问），之后可在面板里取用。`,
    parkedUsage: '用法：/park <内容> — 存起来稍后再问，不会发给 Claude。',
    parkedNone: '没有待问。',
    parkedUnknown: (id: string) => `没有 id 为 ${id} 的待问`,
    parkedUpdated: (what: string, id: string) => `待问 ${id} ${what}`,
    cleanBtn: '清理',
    cleanRequest: (label: string, where: string) => `请清理：${label}${where ? `（${where}）` : ''}`,
    prMerged: (label: string) => `PR 已合并：${label}`,
    prClosed: '已关闭',
    putIn: '✓ 已填入输入框',
    putCopied: '✓ 已复制（没有输入框）',
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
    restored: (t: string) => `已在重新啟動後還原（儲存於 ${t}）`,
    restoreOffer: (t: string, n: number) => `還原此資料夾上次的面板（儲存於 ${t}，${n} 個話題）`,
    saveFailed: '⚠ 面板無法儲存（外掛儲存空間已滿），重新啟動後會遺失',
    needsYou: '等你',
    topics: '話題',
    summary: '總結',
    testing: '測試中',
    created: '已建立',
    merges: '等合併',
    changes: '本機變更',
    copy: '複製',
    copyAll: '全部複製',
    groupIssues: 'Issue',
    groupPrs: 'PR',
    groupOther: '其他',
    copyGroup: '複製本組',
    copiedMark: '已複製',
    copiedRich: '已複製（富連結）',
    copiedMd: '已複製（Markdown）',
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
    parked: '待問',
    parkedCount: (n: number) => `${n} 條待問`,
    parkedFill: '填入',
    parkedCopy: '複製',
    parkedAsked: '已問',
    parkedReopen: '恢復',
    parkedDelete: '刪除',
    parkedShowAsked: (n: number) => `顯示已問 (${n})`,
    parkedHideAsked: (n: number) => `隱藏已問 (${n})`,
    parkedCurrent: '（目前）',
    parkedCopied: '✓ 已複製',
    parkedFilled: '✓ 已填入輸入框',
    parkedFillFailed: '✗ 沒有可填的輸入框',
    parkedSaved: (n: number) => `已存入待問（共 ${n} 條未問），之後可在面板裡取用。`,
    parkedUsage: '用法：/park <內容> — 存起來稍後再問，不會送給 Claude。',
    parkedNone: '沒有待問。',
    parkedUnknown: (id: string) => `沒有 id 為 ${id} 的待問`,
    parkedUpdated: (what: string, id: string) => `待問 ${id} ${what}`,
    cleanBtn: '清理',
    cleanRequest: (label: string, where: string) => `請清理：${label}${where ? `（${where}）` : ''}`,
    prMerged: (label: string) => `PR 已合併：${label}`,
    prClosed: '已關閉',
    putIn: '✓ 已填入輸入框',
    putCopied: '✓ 已複製（沒有輸入框）',
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

// ---- Pane persistence -------------------------------------------------------------------------------------------
// Write-through: every mutation ends in requestSave; writes are coalesced (a burst of calls is one more write) and
// the tool handlers await it, so the record is in the store before the tool call returns.
type Persist = { days: number; hours: number }

const saving: { dirty: boolean; running?: Promise<void> } = { dirty: false }
let restoring: Promise<void> | undefined
let clearedHere = false

async function snapshot($: EngineInterface): Promise<PaneData> {
  return {
    topics: await read($, topics),
    now: await read($, now),
    summary: await read($, summary),
    testing: await read($, testing),
    created: await read($, created),
    merges: await read($, merges),
    changes: await read($, changes),
    agents: await read($, agents),
    closedMerges: await read($, closedMerges),
    updatedAt: await read($, updatedAt),
  }
}

async function applyData($: EngineInterface, d: PaneData): Promise<void> {
  await update($, topics, () => d.topics)
  await update($, now, () => d.now)
  await update($, summary, () => d.summary)
  await update($, testing, () => d.testing)
  await update($, created, () => d.created)
  await update($, merges, () => d.merges)
  await update($, changes, () => d.changes)
  await update($, agents, () => d.agents)
  await update($, closedMerges, () => d.closedMerges)
  await update($, updatedAt, () => d.updatedAt)
}

async function writeNow($: EngineInterface): Promise<void> {
  const at = await whereAmI($)
  if (at.sessionId === '' || at.sessionId === at.sessionName) return
  const data = await snapshot($)
  const key = RECORD_PREFIX + at.sessionId
  if (isEmptyData(data)) {
    await $.store.delete(key)
    await update($, saveWarning, () => false)
    return
  }
  const cwd = await $.session.cwd().catch(() => '')
  const result = await saveRecord($, at.sessionId, {
    v: 1,
    repo: at.repo,
    cwd,
    sessionName: at.sessionName,
    savedAt: Date.now(),
    data,
  })
  await update($, saveWarning, () => result === 'full')
}

function requestSave($: EngineInterface): Promise<void> {
  saving.dirty = true
  saving.running ??= (async () => {
    try {
      while (saving.dirty) {
        saving.dirty = false
        try {
          await writeNow($)
        } catch {
          await update($, saveWarning, () => true).catch(() => undefined)
        }
      }
    } finally {
      delete saving.running
    }
  })()

  return saving.running
}

// Once per plugin start (and hot reload): put the stored pane back into EMPTY atoms. Atoms that already hold data
// (a hot reload) are never overwritten. No record under this session's id: offer the newest record of the same repo
// and working directory (see pickFallback) as a button, never silently.
function ensureRestored($: EngineInterface, cfg: Persist): Promise<void> {
  restoring ??= (async () => {
    try {
      const at = await whereAmI($)
      if (at.sessionId === '' || at.sessionId === at.sessionName) return
      if (!isEmptyData(await snapshot($))) return
      const exact = toRecord(await $.store.get(RECORD_PREFIX + at.sessionId))
      if (exact !== undefined && !isEmptyData(exact.data)) {
        await applyData($, exact.data)
        await update($, restoredNote, () => parkedStamp(exact.savedAt))
        return
      }
      if (clearedHere) return
      const cwd = await $.session.cwd().catch(() => '')
      const pick = pickFallback(await loadRecords($), {
        repo: at.repo,
        cwd,
        hours: cfg.hours,
        nowMs: Date.now(),
        excludeId: at.sessionId,
      })
      if (pick !== undefined) {
        await update($, restoreOffer, () => [
          { id: pick.id, savedAt: pick.rec.savedAt, topics: pick.rec.data.topics.length },
        ])
      }
    } catch {
      // display only: the pane works without a restore
    }
  })()

  return restoring
}

async function acceptOffer($: EngineInterface, id: string): Promise<void> {
  try {
    const key = RECORD_PREFIX + id
    const rec = toRecord(await $.store.get(key))
    if (rec !== undefined && isEmptyData(await snapshot($))) {
      await applyData($, rec.data)
      await update($, restoredNote, () => parkedStamp(rec.savedAt))
      await requestSave($)
      // moved, not copied: the record now lives under this session's id (kept if that write failed)
      if (!(await read($, saveWarning))) await $.store.delete(key)
    }
  } catch {
    // display only
  }
  await update($, restoreOffer, () => [])
}

// Auto-detect merged PRs: read-only `gh pr view` for the awaiting-merge PR urls, sequential, only while merges is non-empty
type MergeWatch = { minutes: number; merged: (label: string) => string; timer?: { cancel: () => void }; checking: boolean }

function stopMergeWatch(w: MergeWatch): void {
  w.timer?.cancel()
  delete w.timer
}

async function runMergeCheck($: EngineInterface, w: MergeWatch): Promise<void> {
  if (w.checking || w.minutes === 0) return
  w.checking = true
  try {
    const targets = (await read($, merges)).filter(x => isPrUrl(x.url))
    if (targets.length === 0) {
      stopMergeWatch(w)
      return
    }
    const states = await checkPrs($, targets)
    const gone = applyMergeStates(targets, states).merged
    await update($, merges, cur => applyMergeStates(cur, states).remaining)
    void requestSave($)
    await update($, closedMerges, cur => {
      const keep = cur.filter(url => states[url] === undefined || states[url] === 'unknown')
      const closedNow = Object.keys(states).filter(url => states[url] === 'closed')
      return [...new Set([...keep, ...closedNow])].filter(url => !gone.some(m => m.url === url))
    })
    void requestSave($)
    for (const one of gone) $.ui.toast(w.merged(clean(one.label)))
    if (!(await read($, merges)).some(x => isPrUrl(x.url))) stopMergeWatch(w)
  } catch {
    // display only: a failed check is skipped until the next period
  } finally {
    w.checking = false
  }
}

function watchMerges($: EngineInterface, w: MergeWatch, checkNow: boolean): void {
  if (w.minutes === 0) return
  if (w.timer === undefined) w.timer = $.clock.every(w.minutes * 60000, () => void runMergeCheck($, w))
  if (checkNow) void runMergeCheck($, w)
}

export const register: Register = (on, options) => {
  const TITLE = typeof options.title === 'string' && options.title.trim() !== '' ? options.title.trim() : 'Task Tracker'
  const L = (typeof options.uiLanguage === 'string' && LABEL_SETS[options.uiLanguage]) || LABELS.en
  const asksOnTop = options.asksOnTop !== false
  const showSummary = options.showSummary !== false
  const showParked = options.showParked !== false
  const rawMinutes = typeof options.mergeCheckMinutes === 'string' ? Number(options.mergeCheckMinutes) : options.mergeCheckMinutes
  const mergeMinutes = typeof rawMinutes === 'number' && Number.isFinite(rawMinutes) && rawMinutes >= 0 ? rawMinutes : 5
  const language = typeof options.language === 'string' ? options.language.trim() : ''
  const writeIn = language !== '' ? language : 'the language the user converses in (follow the user)'

  const days = Number(options.paneRetentionDays)
  const hours = Number(options.paneRestoreHours)
  const cfg: Persist = {
    days: Number.isFinite(days) && days >= 0 && options.paneRetentionDays !== '' ? days : 14,
    hours: Number.isFinite(hours) && hours >= 0 && options.paneRestoreHours !== '' ? hours : 24,
  }

  const watch: MergeWatch = { minutes: mergeMinutes, merged: L.prMerged, checking: false }

  on('session.start', async ($, e, next) => {
    await ensureRestored($, cfg)
    try {
      const at = await whereAmI($)
      await pruneRecords($, { days: cfg.days, nowMs: Date.now(), keepId: at.sessionId })
    } catch {
      // display only: pruning is housekeeping
    }
    try {
      if ((await read($, merges)).some(x => isPrUrl(x.url))) watchMerges($, watch, true)
    } catch {
      // display only
    }
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
        'they are collected at the top of the pane; each is a plain string, or {question, options: [{label, reply?}]} to show answer buttons: ' +
        'give 2-4 options, put the recommended one first with "(recommended)" in its label, and reply = the exact answer text the user would type ' +
        '(defaults to label); clicking an option only fills the prompt box, it never sends). One open question = one card: when a topic spawns several things the ' +
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
                asks: {
                  type: 'array',
                  items: {
                    anyOf: [
                      { type: 'string' },
                      {
                        type: 'object',
                        properties: {
                          question: { type: 'string' },
                          options: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                label: { type: 'string', description: 'Button text; the recommended option first, with "(recommended)"' },
                                reply: { type: 'string', description: 'Exact answer text put in the prompt box; defaults to label' },
                              },
                              required: ['label'],
                            },
                          },
                        },
                        required: ['question', 'options'],
                      },
                    ],
                  },
                },
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
        'created[]: links to things created in this session ({label, url, kind?, parent?}); whenever you create an issue, PR or page, add its full URL right after. ' +
        'kind is issue, pr or something else such as page (when omitted it is inferred from the url: /pull/ is a PR, /issues/ is an issue, anything else goes under Other). ' +
        'The pane groups Created into Issues (numbered), PRs and Other; when you create a sub-issue, set parent to the url of its epic / parent issue so it is listed under it. ' +
        'merges[]: pull requests opened in this session that still wait for the user to merge ({label, url, topic?} with topic the id of the owning topic); add one when you open a PR, and remove it from the awaiting-merge list with merged_urls once the user says it is merged (it stays under created); the pane also checks GitHub PR urls itself with the local gh login and drops merged ones, so you only need merged_urls for other urls. ' +
        'changes[]: changes left on the user\'s machine that outlive the session ({label, detail?, path?, cleanup?}): a registered scheduled task, an environment variable set, an account or credential switched, a deployed service (detail: version or commit), a memory written, and so on; ' +
        'record one whenever you make such a change, set cleanup: true on temporary leftovers that still have to be cleaned up (temporary worktree or branch, test session, temporary directory) so they stand out (an entry with cleanup: true gets a clean button in the pane that only puts a cleanup request in the prompt box; you do the cleaning through normal permissions), set path to what to clean (directory, worktree or branch) so the cleanup request is precise, and remove the entry (remove_labels) once it is cleaned up or no longer applies. ' +
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
                kind: { type: 'string', description: 'issue, pr, or other such as page' },
                parent: { type: 'string', description: 'url of the epic / parent issue this sub-issue belongs to' },
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
                path: { type: 'string', description: 'What to clean (directory, worktree or branch), so the cleanup request is precise' },
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
    await $.tool.register({
      name: 'park_prompt',
      description:
        'Save a question or prompt for the user to ask LATER (a "parked prompt"). Call it ONLY when the user explicitly asks you to park / save / stash something to ask later ' +
        '(e.g. "save this for later", "park that question", "存起来", "待问"); never on your own initiative. ' +
        `text: the prompt exactly as the user would send it, in the user's own words and language. It is kept for all repos and sessions and shown in the "${TITLE}" pane under "Parked prompts"; it is not sent anywhere.`,
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: "The prompt to keep, in the user's own words" } },
        required: ['text'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'list_parked',
      description:
        "Read the user's parked prompts (questions saved to ask later), shared by all repos and sessions. Use it when the user asks to see or pick up their parked prompts " +
        '(e.g. "show my parked prompts", "把待问拿出来"). Each row: id, repo, session, time, status (open | asked), text. ' +
        'repo: only that repo; status: open or asked (default: both). Do not act on a parked prompt unless the user chooses it.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string', description: 'Only prompts parked in this repo (git top-level directory name)' },
          status: { type: 'string', enum: ['open', 'asked'], description: 'Only this status; omit for both' },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'update_parked',
      description:
        'Change one parked prompt by id (from list_parked): status (open | asked; mark asked once the user has asked it), text (rewrite), or delete: true. ' +
        'Only when the user asks for it or after the user has asked a parked prompt.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['open', 'asked'] },
          text: { type: 'string' },
          delete: { type: 'boolean', description: 'true removes the prompt' },
        },
        required: ['id'],
      },
      isDeferred: false,
    })
    await $.command.register({ name: 'tracker', description: `Open the "${TITLE}" pane` })
    await $.command.register({
      name: 'park',
      description: 'Save a prompt to ask later (not sent to Claude)',
      argumentHint: '<text>',
    })

    return next(e)
  })

  on('command.run', { command: 'tracker' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: L.opened }
  })

  on('command.run', { command: 'park' }, async ($, e) => {
    const item = await addParked($, e.args)
    if (item === undefined) return { text: L.parkedUsage }
    const open = (await loadParked($)).filter(x => x.status === 'open').length
    void update($, parkedTick, n => n + 1)
    void $.ui.open({ id: PANE, title: TITLE })

    return { text: L.parkedSaved(open) }
  })

  on('tool.call', { tool: PARK_TOOL }, async ($, e): Promise<ToolCallResult> => {
    const input = e as unknown as { text?: unknown }
    const item = await addParked($, typeof input.text === 'string' ? input.text : '')
    if (item === undefined) return { result: L.parkedUsage }
    const open = (await loadParked($)).filter(x => x.status === 'open').length
    void update($, parkedTick, n => n + 1)
    void $.ui.open({ id: PANE, title: TITLE })

    return { result: `${L.parkedSaved(open)} id: ${item.id}, repo: ${item.repo}` }
  })

  on('tool.call', { tool: LIST_PARKED_TOOL }, async ($, e): Promise<ToolCallResult> => {
    const input = e as unknown as { repo?: unknown; status?: unknown }
    const repo = typeof input.repo === 'string' ? input.repo.trim() : ''
    const status = input.status === 'open' || input.status === 'asked' ? input.status : undefined
    const rows = (await loadParked($)).filter(x => (repo === '' || x.repo === repo) && (status === undefined || x.status === status))
    if (rows.length === 0) return { result: L.parkedNone }

    return {
      result: rows
        .map(x => `[${x.id}] ${x.repo} / ${x.session.name} · ${parkedStamp(Date.parse(x.created_at))} · ${x.status}\n${x.text}`)
        .join('\n\n'),
    }
  })

  on('tool.call', { tool: UPDATE_PARKED_TOOL }, async ($, e): Promise<ToolCallResult> => {
    const input = e as unknown as { id?: unknown; status?: unknown; text?: unknown; delete?: unknown }
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    const status: ParkedStatus | undefined = input.status === 'open' || input.status === 'asked' ? input.status : undefined
    const isDelete = input.delete === true
    const hit = await changeParked($, id, {
      ...(status !== undefined ? { status } : {}),
      ...(typeof input.text === 'string' ? { text: input.text } : {}),
      ...(isDelete ? { delete: true } : {}),
    })
    if (hit === undefined) return { result: L.parkedUnknown(id) }
    void update($, parkedTick, n => n + 1)

    return { result: L.parkedUpdated(isDelete ? 'deleted' : (status ?? 'updated'), id) }
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
      clearedHere = true
      try {
        await saving.running
        await $.store.delete(RECORD_PREFIX + e.sessionId)
        await update($, restoredNote, () => '')
        await update($, restoreOffer, () => [])
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
        await update($, closedMerges, () => [])
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
      void requestSave($)
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
        void requestSave($)
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
        void requestSave($)
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
    await ensureRestored($, cfg)
    await update($, agents, list => {
      const idx = [...list].reverse().findIndex(run => key !== '' && run.description.includes(key))
      if (idx < 0) return list
      const real = list.length - 1 - idx
      matched = list[real]?.description ?? ''
      return list.map((run, i) => (i === real ? { ...run, summary: points, ...(topic ? { topic } : {}) } : run))
    })
    if (matched === '') return { result: L.noAgent(key) }
    await requestSave($)
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
    await ensureRestored($, cfg)
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
    await requestSave($)
    void $.ui.open({ id: PANE, title: TITLE })
    if (m > 0) watchMerges($, watch, Array.isArray(input.merges) && input.merges.length > 0)
    else stopMergeWatch(watch)

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
    await ensureRestored($, cfg)
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
    await requestSave($)
    void $.ui.open({ id: PANE, title: TITLE })

    return { result: L.updated(pairs.length, total) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    await ensureRestored($, cfg)
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
    const closedList = await read($, closedMerges)
    const restoredAtText = await read($, restoredNote)
    const saveFailed = await read($, saveWarning)
    const offers = await read($, restoreOffer)
    const flips = await read($, flipped)
    const copiedKey = await read($, copied)
    await read($, parkedTick)
    const parkFlips = await read($, parkedFlipped)
    const parkedAll: Parked[] = showParked ? await loadParked($).catch(() => []) : []
    const here = parkedAll.length > 0 ? await whereAmI($) : { repo: '', sessionId: '', sessionName: '' }
    const clock = Date.now()

    const toggle = (id: string) => () =>
      update($, expanded, ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]))
    const isFolded = (id: string) => FOLDED_BY_DEFAULT.includes(id) !== flips.includes(id)
    const flip = (id: string) => () =>
      update($, flipped, ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]))
    const copyFormat = typeof options.copyFormat === 'string' ? options.copyFormat : 'rich'
    // copied state: '<how>:<key>' on success (rich / md / plain), '!<key>' on failure
    const copyLinks =
      (key: string, payload: GroupedPayload) =>
      async (press: { surface: string }) => {
        let how = ''
        if (copyFormat === 'rich') {
          try {
            if (await writeRich((argv, init) => $.process.run(argv, init), payload.html, payload.text)) how = 'rich'
          } catch {
            // the runtime refused to start a process: fall back to Markdown
          }
        }
        if (!how) {
          const res = await $.ui.copy({
            text: copyFormat === 'plain' ? payload.text : payload.markdown,
            surface: press.surface as never,
          })
          how = res.isCopied ? (copyFormat === 'plain' ? 'plain' : 'md') : 'fail'
        }
        await update($, copied, () => (how === 'fail' ? `!${key}` : `${how}:${key}`))
        $.clock.after(1500, () => {
          void update($, copied, cur => (cur.endsWith(`:${key}`) || cur === `!${key}` ? '' : cur))
        })
      }
    const groupNames: GroupNames = { issues: L.groupIssues, prs: L.groupPrs, other: L.groupOther }
    const createdItems = createdList.map(i => ({ label: clean(i.label), url: i.url, kind: i.kind, parent: i.parent }))
    const createdGroups = groupLinks(createdItems)
    const copyMark = (key: string) => {
      if (copiedKey === `!${key}`) return ` ✗ ${L.copyFailed}`
      if (copiedKey === `rich:${key}`) return ` ✓ ${L.copiedRich}`
      if (copiedKey === `md:${key}`) return ` ✓ ${L.copiedMd}`
      return copiedKey === `plain:${key}` ? ` ✓ ${L.copiedMark}` : ''
    }
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


    // Parked prompts: repo -> session -> items (stored in $.store, shared by every repo and session)
    const parkedOpenCount = parkedAll.filter(x => x.status === 'open').length
    const parkFlip = (id: string) => () =>
      update($, parkedFlipped, ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]))
    const parkFlag = (id: string, def: boolean) => def !== parkFlips.includes(id)
    const flash = (mark: string, id: string) => {
      void update($, copied, () => `${mark}:${id}`)
      $.clock.after(1500, () => {
        void update($, copied, cur => (cur === `${mark}:${id}` ? '' : cur))
      })
    }
    // Put text in the prompt box (never sends); with no box to fill, copy it instead
    const putText = async (id: string, text: string, mode: 'replace' | 'append' | 'auto', press: { surface: string }) => {
      const draft = mode === 'auto' ? await $.prompt.read().then(x => x.text, () => '') : ''
      const res = await $.prompt.fill({ text, mode: mode === 'auto' ? fillMode(draft) : mode })
      if (res.isFilled) {
        flash('put-ok', id)
        return
      }
      const copy = await $.ui.copy({ text, surface: press.surface as never })
      flash(copy.isCopied ? 'put-copied' : 'put-fail', id)
    }
    const putMark = (id: string) =>
      copiedKey === `put-ok:${id}` ? ` ${L.putIn}` : copiedKey === `put-copied:${id}` ? ` ${L.putCopied}` : copiedKey === `put-fail:${id}` ? ` ✗ ${L.copyFailed}` : ''
    const parkedItem = (item: Parked, indent: number) => (
      <Box key={`parked-${item.id}`} flexDirection="row" marginLeft={indent}>
        <Box flexShrink={1}>
          <Text dimColor={item.status === 'asked'} wrap="truncate-end">
            {item.status === 'asked' ? '✓ ' : '• '}
            {clean(item.text).replace(/\s+/g, ' ')}
            <Text dimColor> · {parkedStamp(Date.parse(item.created_at))}</Text>
          </Text>
        </Box>
        <Button
          key={`park-fill-${item.id}`}
          plain
          dimColor
          label={` ↵ ${L.parkedFill}${copiedKey === `park-fill:${item.id}` ? ` ${L.parkedFilled}` : copiedKey === `park-nofill:${item.id}` ? ` ${L.parkedFillFailed}` : ''}`}
          onPress={async () => {
            const res = await $.prompt.fill({ text: item.text, mode: 'append' })
            flash(res.isFilled ? 'park-fill' : 'park-nofill', item.id)
          }}
        />
        <Button
          key={`park-copy-${item.id}`}
          plain
          dimColor
          label={` ⧉ ${L.parkedCopy}${copiedKey === `park-copy:${item.id}` ? ` ${L.parkedCopied}` : copiedKey === `park-copyfail:${item.id}` ? ` ${L.copyFailed}` : ''}`}
          onPress={async (press: { surface: string }) => {
            const res = await $.ui.copy({ text: item.text, surface: press.surface as never })
            flash(res.isCopied ? 'park-copy' : 'park-copyfail', item.id)
          }}
        />
        <Button
          key={`park-asked-${item.id}`}
          plain
          dimColor
          label={` ${item.status === 'asked' ? `↺ ${L.parkedReopen}` : `✓ ${L.parkedAsked}`}`}
          onPress={async () => {
            await changeParked($, item.id, { status: item.status === 'asked' ? 'open' : 'asked' })
            void update($, parkedTick, n => n + 1)
          }}
        />
        <Button
          key={`park-del-${item.id}`}
          plain
          dimColor
          label={` ✗ ${L.parkedDelete}`}
          onPress={async () => {
            await changeParked($, item.id, { delete: true })
            void update($, parkedTick, n => n + 1)
          }}
        />
      </Box>
    )
    const parkedGroups = groupParked(parkedAll, here.repo, here.sessionId)

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
        {restoredAtText !== '' && <Text dimColor>{L.restored(restoredAtText)}</Text>}
        {saveFailed && <Text color="warning">{L.saveFailed}</Text>}
        {offers.map(o => (
          <Button
            key={`restore-${o.id}`}
            plain
            label={`↺ ${L.restoreOffer(parkedStamp(o.savedAt), o.topics)}`}
            onPress={() => acceptOffer($, o.id)}
          />
        ))}
        {list.length === 0 && sessionSummary === '' && testingList.length + createdList.length + mergeList.length + changeList.length === 0 && (
          <Text dimColor>{L.empty}</Text>
        )}

        {asksOnTop && asks.length > 0 && section(L.needsYou, asks.length)}
        {(asksOnTop ? asks : []).map(({ topic, ask }, i) => (
          <Box key={`ask-${i}`} flexDirection="column">
            <Button
              key={`ask-btn-${i}`}
              plain
              label={`? ${clean(askText(ask))}`}
              onPress={reveal(topic.id)}
            />
            {askOptions(ask).length > 0 && (
              <Box flexDirection="row" flexWrap="wrap" marginLeft={2}>
                {askOptions(ask).map((opt, j) => (
                  <Button
                    key={`ask-opt-${i}-${j}`}
                    plain
                    label={`[ ${clean(opt.label)} ]${putMark(`ask-${i}-${j}`)} `}
                    onPress={(press: { surface: string }) => putText(`ask-${i}-${j}`, optionReply(opt), 'auto', press)}
                  />
                ))}
              </Box>
            )}
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
                  {closedList.includes(item.url) ? <Text color="error"> [{L.prClosed}]</Text> : ''}
                  {owner ? ` · ← ${owner.id}. ${clean(owner.title)}` : ''}
                </Text>
              </Box>
            </Box>
          )
        })}

        {showSummary && sessionSummary !== '' && fold('summary', L.summary, sessionSummary.split('\n').filter(x => x.trim() !== '').length)}
        {showSummary && sessionSummary !== '' && !isFolded('summary') && rich(sessionSummary)}

        {parkedAll.length > 0 && fold('parked', L.parked, parkedOpenCount)}
        {parkedAll.length > 0 &&
          !isFolded('parked') &&
          parkedGroups.map(rg => {
            const isHere = rg.repo === here.repo
            const askedN = rg.sessions.reduce((n, sg) => n + sg.items.filter(x => x.status === 'asked').length, 0)
            const openN = rg.count - askedN
            const showAsked = parkFlag(`asked:${rg.repo}`, false)
            const repoOpen = parkFlag(`repo:${rg.repo}`, isHere)
            return (
              <Box key={`parked-repo-${rg.repo}`} flexDirection="column">
                <Box flexDirection="row">
                  <Button
                    key={`park-repo-${rg.repo}`}
                    plain
                    label={`${repoOpen ? '▾' : '▸'} ${rg.repo}${isHere ? L.parkedCurrent : ''} · ${L.parkedCount(openN)}`}
                    onPress={parkFlip(`repo:${rg.repo}`)}
                  />
                  {repoOpen && askedN > 0 && (
                    <Button
                      key={`park-showasked-${rg.repo}`}
                      plain
                      dimColor
                      label={` · ${showAsked ? L.parkedHideAsked(askedN) : L.parkedShowAsked(askedN)}`}
                      onPress={parkFlip(`asked:${rg.repo}`)}
                    />
                  )}
                </Box>
                {repoOpen &&
                  rg.sessions.map(sg => {
                    const items = sg.items.filter(x => showAsked || x.status === 'open')
                    if (items.length === 0) return null
                    const isNow = sg.id === here.sessionId
                    const sessOpen = parkFlag(`sess:${rg.repo}:${sg.id}`, isNow)
                    return (
                      <Box key={`parked-sess-${rg.repo}-${sg.id}`} flexDirection="column" marginLeft={2}>
                        <Button
                          key={`park-sess-${rg.repo}-${sg.id}`}
                          plain
                          dimColor={!isNow}
                          label={`${sessOpen ? '▾' : '▸'} ${sg.name}${isNow ? L.parkedCurrent : ''} · ${items.length}`}
                          onPress={parkFlip(`sess:${rg.repo}:${sg.id}`)}
                        />
                        {sessOpen && items.map(item => parkedItem(item, 2))}
                      </Box>
                    )
                  })}
              </Box>
            )
          })}

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
                onPress={copyLinks('created-all', groupedPayload(createdGroups, groupNames))}
              />
            ),
          )}
        {(isFolded('created') ? [] : createdGroups).map(g => {
          const row = (item: (typeof createdItems)[number], mark: string, indent: number, showKind: boolean) => (
            <Box key={`created-${item.url}`} flexDirection="row" marginLeft={indent}>
              <Text color="success">{mark} </Text>
              <Box flexShrink={1}>
                <Text>
                  {showKind && item.kind ? `${item.kind} · ` : ''}
                  <Link href={item.url}>{item.label}</Link>
                </Text>
              </Box>
              <Button
                key={`copy-created-${item.url}`}
                plain
                dimColor
                label={` ⧉ ${L.copy}${copyMark(`created-${item.url}`)}`}
                onPress={copyLinks(`created-${item.url}`, singlePayload(item))}
              />
            </Box>
          )
          return (
            <Box key={`created-group-${g.id}`} flexDirection="column">
              <Box flexDirection="row">
                <Text bold>{groupNames[g.id]}</Text>
                <Button
                  key={`copy-group-${g.id}`}
                  plain
                  dimColor
                  label={` ⧉ ${L.copyGroup}${copyMark(`group-${g.id}`)}`}
                  onPress={copyLinks(`group-${g.id}`, groupedPayload([g], groupNames))}
                />
              </Box>
              {g.nodes.map((n, a) =>
                g.id === 'issues' ? (
                  <Box key={`created-node-${n.item.url}`} flexDirection="column">
                    {row(n.item, `${a + 1}.`, 0, false)}
                    {n.children.map((c, k) => row(c, `${a + 1}.${k + 1}`, 3, false))}
                  </Box>
                ) : (
                  row(n.item, '•', 0, g.id === 'other')
                ),
              )}
            </Box>
          )
        })}

        {changeList.length > 0 && fold('changes', L.changes, changeList.length)}
        {(isFolded('changes') ? [] : changeList).map(item => (
          <Box key={`change-${item.label}`} flexDirection="row">
            <Text color={item.cleanup ? 'warning' : 'subtle'}>{item.cleanup ? '🧹 ' : '• '}</Text>
            <Box flexShrink={1}>
              <Text>
                {item.cleanup ? <Text color="warning" bold>[{L.cleanup}] </Text> : ''}
                {clean(item.label)}
                {item.detail ? ` · ${clean(item.detail)}` : ''}
                {item.path ? ` · ${clean(item.path)}` : ''}
              </Text>
            </Box>
            {item.cleanup === true && (
              <Button
                key={`clean-${item.label}`}
                plain
                label={` 🧹 ${L.cleanBtn}${putMark(`clean-${item.label}`)}`}
                onPress={(press: { surface: string }) =>
                  putText(`clean-${item.label}`, L.cleanRequest(item.label, item.path ?? item.detail ?? ''), 'append', press)
                }
              />
            )}
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
                  {group(L.asks, 'warning', t.asks?.map(askText), '? ')}
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
