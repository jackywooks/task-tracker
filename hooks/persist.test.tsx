import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { MAX_RECORD_CHARS, capRecord, emptyData, isEmptyData, pickFallback, toRecord } from './persist'
import type { PaneRecord, Stored } from './persist'

const PANE = {
  plugin: 'task-tracker',
  component: 'Pane',
  requestId: 'task-tracker',
  props: { title: 'T', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const DAY = 86400000

const record = (over: Partial<PaneRecord> = {}, topicTitle = 'saved topic'): PaneRecord => ({
  v: 1,
  repo: 'alpha',
  cwd: '/work/alpha',
  sessionName: '2026-10-26 09:00',
  savedAt: Date.now(),
  data: { ...emptyData(), topics: [{ id: '1', title: topicTitle, status: 'doing' }] },
  ...over,
})

const stored = (id: string, over: Partial<PaneRecord> = {}): Stored => ({ key: `session:${id}`, id, rec: record(over) })

// What the engine answers for the session the plugin runs in
// The engine's store, kept in a Map the test can read; `full` makes every write fail
const memory = (on: On, entries: Record<string, unknown> = {}, full = false) => {
  const map = new Map<string, unknown>(Object.entries(entries))
  on('store.get', (_, e) => ({ value: map.get((e as unknown as { key: string }).key) }))
  on('store.set', (_, e) => {
    if (full) throw new Error('store over 4 MiB')
    const x = e as unknown as { key: string; value: unknown }
    map.set(x.key, JSON.parse(JSON.stringify(x.value)))

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    map.delete((e as unknown as { key: string }).key)

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...map.keys()] }))

  return map
}

const engine = (on: On, id = 's1') => {
  on('tool.register', () => ({ value: { name: 'x' } as never }))
  on('session.id', () => ({ value: id }))
  on('session.repo', () => ({ value: { root: '/work/alpha', remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: '/work/alpha' }))
  on('session.usage', () => ({ value: { startedAt: Date.now() } as never }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

// `find` with a `label` pattern is not a filter on its own: list the buttons and match by hand
const labels = async (ui: { findAll: (q: { type: 'Button' }) => Promise<readonly { text?: string }[]> }) =>
  (await ui.findAll({ type: 'Button' })).map(b => b.text ?? '')

const call = ($: { tool: { call: (x: never) => Promise<unknown> } }, tool: string, input: Record<string, unknown>) =>
  $.tool.call({ tool: `mcp__task-tracker__${tool}`, ...input } as never)

test('set_topics writes the pane to the store before it returns', async ($, on) => {
  const map = memory(on)
  engine(on)
  await $.session.start({ cwd: '/work/alpha', surface: 'terminal', isInteractive: true })
  await call($, 'set_topics', { topics: [{ id: '1', title: 'first', status: 'doing' }], now: '1' })
  await call($, 'set_session', { summary: 'where we are', created: [{ label: 'PR', url: 'https://github.com/o/r/pull/9' }] })

  const rec = toRecord(map.get('session:s1'))
  expect(rec?.repo).toBe('alpha')
  expect(rec?.cwd).toBe('/work/alpha')
  expect(rec?.data.topics.map(t => t.title)).toEqual(['first'])
  expect(rec?.data.now).toBe('1')
  expect(rec?.data.summary).toBe('where we are')
  expect(rec?.data.created.map(c => c.label)).toEqual(['PR'])
})

test('a new process with the same session id gets the pane back in its empty atoms', async ($, on) => {
  memory(on, { 'session:s1': record() })
  engine(on)
  await $.session.start({ cwd: '/work/alpha', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Restored after a restart/ })).toBeDefined()
  expect((await labels(ui)).some(t => /saved topic/.test(t))).toBe(true)
  await ui.unmount()
})

test('atoms that already hold data are not overwritten by the store (hot reload)', async ($, on) => {
  const map = memory(on, { 'session:s1': record({}, 'old topic from the store') })
  engine(on)
  on('state.get', (_, e) => {
    const key = (e as unknown as { key: string }).key
    const text = ['now', 'updatedAt', 'summary', 'copied', 'restoredNote'].includes(key)
    const value =
      key === 'topics' ? [{ id: '9', title: 'live topic', status: 'doing' }] : text ? '' : key === 'parkedTick' ? 0 : key === 'saveWarning' ? false : []

    return { value: { value, version: 1 } }
  })
  await $.session.start({ cwd: '/work/alpha', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await labels(ui)
  expect(all.some(t => /live topic/.test(t))).toBe(true)
  expect(all.some(t => /old topic/.test(t))).toBe(false)
  expect(toRecord(map.get('session:s1'))?.data.topics[0]?.title).toBe('old topic from the store')
  await ui.unmount()
})

test('a different session id gets a restore button, not the data', async ($, on) => {
  const map = memory(on, { 'session:old': record({}, 'topic of the old id') })
  engine(on, 'new-id')
  await $.session.start({ cwd: '/work/alpha', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  let all = await labels(ui)
  expect(all.some(t => /topic of the old id/.test(t))).toBe(false)
  expect(all.some(t => /Restore the last pane/.test(t))).toBe(true)
  await ui.press({ plugin: 'task-tracker', key: 'restore-old' })
  all = await labels(ui)
  expect(all.some(t => /topic of the old id/.test(t))).toBe(true)
  expect(all.some(t => /Restore the last pane/.test(t))).toBe(false)
  // moved under the new id
  expect(toRecord(map.get('session:new-id'))?.data.topics.length).toBe(1)
  expect(map.has('session:old')).toBe(false)
  await ui.unmount()
})

test('fallback: same repo and folder, within the window, newest first, never itself or an empty one', () => {
  const now = Date.now()
  const opts = { repo: 'alpha', cwd: '/work/alpha', hours: 24, nowMs: now, excludeId: 'me' }
  const list: Stored[] = [
    stored('me', { savedAt: now }),
    stored('other-repo', { repo: 'beta', savedAt: now }),
    stored('other-dir', { cwd: '/work/alpha/sub', savedAt: now }),
    stored('too-old', { savedAt: now - 25 * 3600000 }),
    { key: 'session:empty', id: 'empty', rec: { ...record({ savedAt: now }), data: emptyData() } },
    stored('older', { savedAt: now - 5 * 3600000 }),
    stored('newer', { savedAt: now - 1 * 3600000 }),
  ]
  expect(pickFallback(list, opts)?.id).toBe('newer')
  expect(pickFallback(list.filter(s => s.id !== 'newer' && s.id !== 'older'), opts)).toBeUndefined()
})

test('retention drops old and malformed records on session start, and keeps the current id', async ($, on) => {
  const now = Date.now()
  const map = memory(on, {
    parked: [],
    'session:fresh': record({ savedAt: now - 2 * DAY }),
    'session:stale': record({ savedAt: now - 20 * DAY }),
    'session:s1': record({ savedAt: now - 40 * DAY }),
    'session:junk': { nope: true },
  })
  engine(on)
  await $.session.start({ cwd: '/work/alpha', surface: 'terminal', isInteractive: true })
  expect([...map.keys()].sort()).toEqual(['parked', 'session:fresh', 'session:s1'])
})

test('retention also drops the oldest records while the total is over budget', async ($, on) => {
  const now = Date.now()
  const big = (savedAt: number) => {
    const r = record({ savedAt })
    r.data.summary = 'x'.repeat(1_200_000)
    return r
  }
  const map = memory(on, { 'session:a': big(now - 3000), 'session:b': big(now - 2000), 'session:c': big(now - 1000) })
  engine(on)
  await $.session.start({ cwd: '/work/alpha', surface: 'terminal', isInteractive: true })
  // 3 x 1.2 MB is over the 3 MiB budget: the oldest goes
  expect([...map.keys()].sort()).toEqual(['session:b', 'session:c'])
})

test('a record is trimmed to the size cap: reports first, then oldest agents and links', () => {
  const big = 'x'.repeat(40000)
  const agent = (i: number) => ({
    key: `k${i}`,
    description: `agent ${i}`,
    type: 'coder',
    model: 'm',
    background: false,
    startedAt: i,
    status: 'done' as const,
    tools: 1,
    report: big,
  })
  const rec = record()
  rec.data.agents = Array.from({ length: 20 }, (_, i) => agent(i))
  rec.data.created = Array.from({ length: 5 }, (_, i) => ({ label: `c${i}`, url: `https://example.com/${i}` }))

  const cut = capRecord(rec, 20000)
  expect(JSON.stringify(cut).length).toBeLessThanOrEqual(20000)
  expect(cut.trimmed).toBe(true)
  expect(cut.data.agents.length).toBe(20)
  expect(cut.data.agents.every(a => (a.report ?? '').length <= 500)).toBe(true)

  const out = capRecord(rec, 3000)
  expect(JSON.stringify(out).length).toBeLessThanOrEqual(3000)
  expect(out.data.topics.length).toBe(1)
  expect(out.data.agents.length).toBeLessThan(20)
  expect(out.data.agents.every(a => a.report === undefined)).toBe(true)
  // under the real cap a normal pane is untouched
  expect(capRecord(record(), MAX_RECORD_CHARS).trimmed).toBeUndefined()
  expect(isEmptyData(out.data)).toBe(false)
})

test('a full store keeps the pane working and shows a warning', async ($, on) => {
  memory(on, {}, true)
  engine(on)
  await $.session.start({ cwd: '/work/alpha', surface: 'terminal', isInteractive: true })
  await call($, 'set_topics', { topics: [{ id: '1', title: 'still shown', status: 'doing' }] })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await labels(ui)).some(t => /still shown/.test(t))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /could not be saved/ })).toBeDefined()
  await ui.unmount()
})
