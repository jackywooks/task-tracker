import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'task-tracker',
  component: 'Pane',
  requestId: 'task-tracker',
  props: { title: 'T', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const item = (id: string, repo: string, session: string, status: string) => ({
  id,
  text: `question ${id}`,
  created_at: '2026-10-25T10:00:00.000Z',
  repo,
  session: { id: session, name: `name-${session}` },
  status,
})

test('parked prompts are grouped by repo then session, asked ones hidden', async ($, on) => {
  on('session.repo', () => ({ value: { root: '/x/alpha', remote: null, internal: false, name: null } }))
  on('session.id', () => ({ value: 's1' }))
  on('store.get', () => ({
    value: [item('a', 'alpha', 's1', 'open'), item('b', 'beta', 's2', 'open'), item('c', 'alpha', 's1', 'asked')],
  }))
  on('state.get', (_, e) => {
    const key = (e as unknown as { key: string }).key
    const text = ['now', 'updatedAt', 'summary', 'copied'].includes(key)

    return { value: { value: text ? '' : key === 'parkedTick' ? 0 : [], version: 1 } }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Button', label: /Parked prompts|待问/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', label: /alpha \(current\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', label: /beta/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /question a/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /question c/ })).toBeUndefined()
  await ui.unmount()
})
