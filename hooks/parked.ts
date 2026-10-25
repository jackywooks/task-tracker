import type { EngineInterface } from 'claude-code'

// Parked prompts: questions saved to ask later. Kept in the plugin's own store (`$.store`, one JSON file under the
// user's Claude Code config directory), so every repo and every session shares one list and /clear never touches it.
export const STORE_KEY = 'parked'
const MAX_TEXT = 4000

export type ParkedStatus = 'open' | 'asked'

export type Parked = {
  id: string
  text: string
  created_at: string
  repo: string
  session: { id: string; name: string }
  status: ParkedStatus
  asked_at?: string
}

export type Where = { repo: string; sessionId: string; sessionName: string }

const pad = (n: number): string => String(n).padStart(2, '0')

export function stamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

// Repo = git top-level directory name (the main working tree's for a worktree); no git: last segment of the cwd.
// Session = its id plus a readable name: the API has no session title, so the name is when the session began.
export async function whereAmI($: EngineInterface): Promise<Where> {
  let repo = ''
  try {
    const found = await $.session.repo()
    if (found) repo = lastSegment(found.root)
  } catch {
    // fall through to the cwd
  }
  if (repo === '') {
    try {
      repo = lastSegment(await $.session.cwd())
    } catch {
      repo = '(unknown)'
    }
  }
  let sessionId = ''
  let sessionName = ''
  try {
    sessionId = await $.session.id()
  } catch {
    // keep empty
  }
  try {
    sessionName = stamp((await $.session.usage()).startedAt)
  } catch {
    sessionName = stamp(Date.now())
  }
  if (sessionId === '') sessionId = sessionName

  return { repo, sessionId, sessionName }
}

function toParked(raw: unknown): Parked | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.text !== 'string') return undefined
  const s = (o.session && typeof o.session === 'object' ? o.session : {}) as Record<string, unknown>
  const item: Parked = {
    id: o.id,
    text: o.text,
    created_at: typeof o.created_at === 'string' ? o.created_at : '',
    repo: typeof o.repo === 'string' ? o.repo : '',
    session: { id: typeof s.id === 'string' ? s.id : '', name: typeof s.name === 'string' ? s.name : '' },
    status: o.status === 'asked' ? 'asked' : 'open',
  }
  if (typeof o.asked_at === 'string') item.asked_at = o.asked_at
  return item
}

export async function loadParked($: EngineInterface): Promise<Parked[]> {
  const raw = await $.store.get(STORE_KEY)
  return (Array.isArray(raw) ? raw : []).map(toParked).filter((x): x is Parked => x !== undefined)
}

export async function saveParked($: EngineInterface, list: Parked[]): Promise<void> {
  await $.store.set(STORE_KEY, list)
}

export async function addParked($: EngineInterface, text: string): Promise<Parked | undefined> {
  const body = text.trim().slice(0, MAX_TEXT)
  if (body === '') return undefined
  const at = await whereAmI($)
  const item: Parked = {
    id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    text: body,
    created_at: new Date().toISOString(),
    repo: at.repo,
    session: { id: at.sessionId, name: at.sessionName },
    status: 'open',
  }
  await saveParked($, [...(await loadParked($)), item])

  return item
}

export type ParkedChange = { status?: ParkedStatus; text?: string; delete?: boolean }

// Returns the changed item, or undefined when the id is unknown
export async function changeParked($: EngineInterface, id: string, change: ParkedChange): Promise<Parked | undefined> {
  const list = await loadParked($)
  const at = list.findIndex(x => x.id === id)
  if (at < 0) return undefined
  const old = list[at] as Parked
  if (change.delete === true) {
    await saveParked($, list.filter((_, i) => i !== at))
    return old
  }
  const next: Parked = { ...old }
  if (typeof change.text === 'string' && change.text.trim() !== '') next.text = change.text.trim().slice(0, MAX_TEXT)
  if (change.status === 'open') {
    next.status = 'open'
    delete next.asked_at
  } else if (change.status === 'asked') {
    next.status = 'asked'
    next.asked_at = new Date().toISOString()
  }
  list[at] = next
  await saveParked($, list)

  return next
}

export type SessionGroup = { id: string; name: string; items: Parked[] }
export type RepoGroup = { repo: string; sessions: SessionGroup[]; count: number }

// repo -> session -> items. The current repo first, then repos by newest item; sessions and items newest first.
export function groupParked(list: Parked[], currentRepo: string, currentSession: string): RepoGroup[] {
  const repos = new Map<string, Map<string, SessionGroup>>()
  for (const item of list) {
    const sessions = repos.get(item.repo) ?? new Map<string, SessionGroup>()
    repos.set(item.repo, sessions)
    const group = sessions.get(item.session.id) ?? { id: item.session.id, name: item.session.name, items: [] }
    sessions.set(item.session.id, group)
    group.items.push(item)
  }
  const newest = (items: Parked[]) => items.reduce((m, i) => (i.created_at > m ? i.created_at : m), '')
  const out: RepoGroup[] = []
  for (const [repo, sessions] of repos) {
    const groups = [...sessions.values()]
    for (const g of groups) g.items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    groups.sort((a, b) =>
      a.id === currentSession ? -1 : b.id === currentSession ? 1 : newest(a.items) < newest(b.items) ? 1 : -1,
    )
    out.push({ repo, sessions: groups, count: groups.reduce((n, g) => n + g.items.length, 0) })
  }
  const latest = (g: RepoGroup) => newest(g.sessions.flatMap(s => s.items))
  out.sort((a, b) => (a.repo === currentRepo ? -1 : b.repo === currentRepo ? 1 : latest(a) < latest(b) ? 1 : -1))

  return out
}
