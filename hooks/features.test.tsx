import { expect, test } from 'claude-code/testing'

import { applyMergeStates, askOptions, fillMode, optionReply, prState } from './merges'

const PANE = {
  plugin: 'task-tracker',
  component: 'Pane',
  requestId: 'task-tracker',
  props: { title: 'T', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const seed = (values: Record<string, unknown>) => (_: unknown, e: unknown) => {
  const key = (e as { key: string }).key
  const text = ['now', 'updatedAt', 'summary', 'copied'].includes(key)
  const fallback = text ? '' : key === 'parkedTick' ? 0 : []

  return { value: { value: key in values ? values[key] : fallback, version: 1 } }
}

test('cleanup button shows only for cleanup:true entries', async ($, on) => {
  on('store.get', () => ({ value: [] }))
  on(
    'state.get',
    seed({
      flipped: ['changes'],
      changes: [
        { label: 'temp worktree', path: '/tmp/wt-1', cleanup: true },
        { label: 'scheduled task', detail: 'v2' },
      ],
    }),
  )
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  const clean = (await ui.findAll({ type: 'Button' })).filter(b => String(b.key).startsWith('clean-'))
  expect(clean.map(b => b.key)).toEqual(['clean-temp worktree'])
  await ui.unmount()
})

test('ask options render as buttons, plain string asks keep working', async ($, on) => {
  on('store.get', () => ({ value: [] }))
  on(
    'state.get',
    seed({
      topics: [
        {
          id: '1',
          title: 'T1',
          status: 'waiting',
          asks: ['plain question', { question: 'which one?', options: [{ label: 'A (recommended)', reply: 'go A' }, { label: 'B' }] }],
        },
      ],
    }),
  )
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Button', label: /plain question/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', label: /which one/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', label: /A \(recommended\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', label: /\[ B \]/ })).toBeDefined()
  await ui.unmount()
})

test('gh result maps to a state', () => {
  expect(prState({ exitCode: 0, stdout: '{"state":"MERGED","mergedAt":"2026-10-26T00:00:00Z"}' })).toBe('merged')
  expect(prState({ exitCode: 0, stdout: '{"state":"CLOSED","mergedAt":null}' })).toBe('closed')
  expect(prState({ exitCode: 0, stdout: '{"state":"OPEN","mergedAt":null}' })).toBe('open')
  expect(prState({ exitCode: 1, stdout: '' })).toBe('unknown')
  expect(prState({ exitCode: 0, stdout: 'not json' })).toBe('unknown')
})

test('merge-check reducer removes merged, flags closed, keeps the rest', () => {
  const list = [
    { label: 'a', url: 'https://github.com/o/r/pull/1' },
    { label: 'b', url: 'https://github.com/o/r/pull/2' },
    { label: 'c', url: 'https://github.com/o/r/pull/3' },
    { label: 'd', url: 'https://example.com/x' },
  ]
  const out = applyMergeStates(list, {
    'https://github.com/o/r/pull/1': 'merged',
    'https://github.com/o/r/pull/2': 'closed',
    'https://github.com/o/r/pull/3': 'unknown',
  })
  expect(out.merged.map(x => x.label)).toEqual(['a'])
  expect(out.remaining.map(x => x.label)).toEqual(['b', 'c', 'd'])
  expect(out.closed).toEqual(['https://github.com/o/r/pull/2'])
})

test('ask helpers', () => {
  expect(askOptions('x')).toEqual([])
  expect(optionReply({ label: 'A' })).toBe('A')
  expect(optionReply({ label: 'A', reply: 'go' })).toBe('go')
  expect(fillMode('')).toBe('replace')
  expect(fillMode('draft')).toBe('append')
})
