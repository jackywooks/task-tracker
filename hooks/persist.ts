import type { EngineInterface } from 'claude-code'

import type { AgentRun, LocalChange, SessionLink, Topic } from '../types'

// Pane persistence. The pane lives in `$.state` (in memory, gone when the process restarts); every change is also
// written to `$.store` under `session:<id>`, and put back into empty atoms when the plugin starts again.
export const RECORD_PREFIX = 'session:'
// One record stays under this many characters of JSON; the whole store (parked prompts included) is capped at 4 MiB
export const MAX_RECORD_CHARS = 256 * 1024
// Soft budget for all pane records together, so the parked prompts always have room
export const MAX_TOTAL_CHARS = 3 * 1024 * 1024

export type PaneData = {
  topics: Topic[]
  now: string
  summary: string
  testing: SessionLink[]
  created: SessionLink[]
  merges: SessionLink[]
  changes: LocalChange[]
  agents: AgentRun[]
  closedMerges: string[]
  updatedAt: string
}

export type PaneRecord = {
  v: 1
  repo: string
  cwd: string
  sessionName: string
  savedAt: number
  trimmed?: boolean
  data: PaneData
}

export type Stored = { key: string; id: string; rec: PaneRecord }

export const emptyData = (): PaneData => ({
  topics: [],
  now: '',
  summary: '',
  testing: [],
  created: [],
  merges: [],
  changes: [],
  agents: [],
  closedMerges: [],
  updatedAt: '',
})

// What counts as content: updatedAt, now and closedMerges alone do not make a pane worth restoring
export function isEmptyData(d: PaneData): boolean {
  return (
    d.topics.length === 0 &&
    d.summary === '' &&
    d.testing.length === 0 &&
    d.created.length === 0 &&
    d.merges.length === 0 &&
    d.changes.length === 0 &&
    d.agents.length === 0
  )
}

const size = (x: unknown): number => JSON.stringify(x).length

// Trim a record until it fits: agent reports first (the longest text), then the oldest agents, created links, testing links
export function capRecord(rec: PaneRecord, max = MAX_RECORD_CHARS): PaneRecord {
  if (size(rec) <= max) return rec
  const out: PaneRecord = { ...rec, trimmed: true, data: { ...rec.data } }
  const d = out.data
  d.agents = d.agents.map(a => (a.report !== undefined && a.report.length > 500 ? { ...a, report: a.report.slice(0, 500) } : a))
  if (size(out) <= max) return out
  d.agents = d.agents.map(a => {
    const { report: _dropped, ...rest } = a
    void _dropped
    return rest
  })
  for (const key of ['agents', 'created', 'testing'] as const) {
    while (size(out) > max && d[key].length > 0) d[key] = d[key].slice(1) as never
  }

  return out
}

const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : [])
const text = (x: unknown): string => (typeof x === 'string' ? x : '')

export function toRecord(raw: unknown): PaneRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  if (o.v !== 1 || typeof o.savedAt !== 'number' || !o.data || typeof o.data !== 'object') return undefined
  const d = o.data as Record<string, unknown>
  const rec: PaneRecord = {
    v: 1,
    repo: text(o.repo),
    cwd: text(o.cwd),
    sessionName: text(o.sessionName),
    savedAt: o.savedAt,
    data: {
      topics: arr<Topic>(d.topics),
      now: text(d.now),
      summary: text(d.summary),
      testing: arr<SessionLink>(d.testing),
      created: arr<SessionLink>(d.created),
      merges: arr<SessionLink>(d.merges),
      changes: arr<LocalChange>(d.changes),
      agents: arr<AgentRun>(d.agents),
      closedMerges: arr<string>(d.closedMerges),
      updatedAt: text(d.updatedAt),
    },
  }
  if (o.trimmed === true) rec.trimmed = true

  return rec
}

export async function loadRecords($: EngineInterface): Promise<Stored[]> {
  const keys = (await $.store.keys()).filter(k => k.startsWith(RECORD_PREFIX))
  const out: Stored[] = []
  for (const key of keys) {
    const rec = toRecord(await $.store.get(key))
    if (rec !== undefined) out.push({ key, id: key.slice(RECORD_PREFIX.length), rec })
  }

  return out
}

// 'full': the store refused the write (over its 4 MiB); older records were dropped to make room, and it still failed
export async function saveRecord($: EngineInterface, id: string, rec: PaneRecord): Promise<'ok' | 'full'> {
  const key = RECORD_PREFIX + id
  const capped = capRecord(rec)
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await $.store.set(key, capped)
      return 'ok'
    } catch {
      const others = (await loadRecords($).catch(() => [])).filter(s => s.key !== key)
      const oldest = others.sort((a, b) => a.rec.savedAt - b.rec.savedAt)[0]
      if (oldest === undefined) return 'full'
      await $.store.delete(oldest.key)
    }
  }

  return 'full'
}

// Drop records older than `days`, then the oldest ones while the total is over budget; the current id is never dropped.
// Returns the keys deleted.
export async function pruneRecords(
  $: EngineInterface,
  opts: { days: number; nowMs: number; keepId: string; maxTotal?: number },
): Promise<string[]> {
  const gone: string[] = []
  const keys = (await $.store.keys()).filter(k => k.startsWith(RECORD_PREFIX))
  const live: Stored[] = []
  for (const key of keys) {
    const rec = toRecord(await $.store.get(key))
    const id = key.slice(RECORD_PREFIX.length)
    if (rec === undefined || (id !== opts.keepId && opts.nowMs - rec.savedAt > opts.days * 86400000)) {
      await $.store.delete(key)
      gone.push(key)
    } else live.push({ key, id, rec })
  }
  const max = opts.maxTotal ?? MAX_TOTAL_CHARS
  let total = live.reduce((n, s) => n + size(s.rec), 0)
  for (const s of live.sort((a, b) => a.rec.savedAt - b.rec.savedAt)) {
    if (total <= max) break
    if (s.id === opts.keepId) continue
    await $.store.delete(s.key)
    gone.push(s.key)
    total -= size(s.rec)
  }

  return gone
}

// The id may change when a session is resumed or restarted; the closest thing to "the same session" is the newest
// non-empty record of the same repo and the same working directory saved within `hours`. It is only ever offered,
// never applied without a click.
export function pickFallback(
  records: Stored[],
  opts: { repo: string; cwd: string; hours: number; nowMs: number; excludeId: string },
): Stored | undefined {
  return records
    .filter(
      s =>
        s.id !== opts.excludeId &&
        s.rec.repo === opts.repo &&
        s.rec.cwd === opts.cwd &&
        opts.nowMs - s.rec.savedAt <= opts.hours * 3600000 &&
        !isEmptyData(s.rec.data),
    )
    .sort((a, b) => b.rec.savedAt - a.rec.savedAt)[0]
}
