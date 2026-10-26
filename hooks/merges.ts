import type { EngineInterface } from 'claude-code'

import type { Ask, AskOption, SessionLink } from '../types'

const PR_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\/?$/

export type PrState = 'merged' | 'closed' | 'open' | 'unknown'

export function isPrUrl(url: string): boolean {
  return PR_URL.test(url)
}

// Pure: turn the result of `gh pr view <url> --json state,mergedAt` into a state; anything odd is 'unknown' (skipped silently)
export function prState(result: { exitCode: number; stdout: string }): PrState {
  if (result.exitCode !== 0) return 'unknown'
  try {
    const o = JSON.parse(result.stdout) as { state?: unknown; mergedAt?: unknown }
    if (o.state === 'MERGED' || (typeof o.mergedAt === 'string' && o.mergedAt !== '')) return 'merged'
    if (o.state === 'CLOSED') return 'closed'
    if (o.state === 'OPEN') return 'open'
  } catch {
    // not JSON: gh missing, not logged in, or an error page
  }
  return 'unknown'
}

// Pure reducer: merged entries leave the list, closed ones are reported so the pane can badge them
export function applyMergeStates(
  list: SessionLink[],
  states: Record<string, PrState>,
): { remaining: SessionLink[]; merged: SessionLink[]; closed: string[] } {
  const merged = list.filter(one => states[one.url] === 'merged')
  const remaining = list.filter(one => states[one.url] !== 'merged')
  const closed = remaining.filter(one => states[one.url] === 'closed').map(one => one.url)
  return { remaining, merged, closed }
}

// Read-only `gh pr view`, one PR at a time, argv array (no shell), 15 s timeout each. Never touches gh accounts or GH_TOKEN.
export async function checkPrs($: EngineInterface, list: SessionLink[]): Promise<Record<string, PrState>> {
  const states: Record<string, PrState> = {}
  for (const one of list) {
    if (!isPrUrl(one.url)) continue
    try {
      const res = await $.process.run(['gh', 'pr', 'view', one.url, '--json', 'state,mergedAt'], { timeoutMs: 15000 })
      states[one.url] = prState(res)
    } catch {
      states[one.url] = 'unknown'
    }
  }
  return states
}

// An ask is a string or {question, options}; normalise for display
export function askText(ask: Ask): string {
  return typeof ask === 'string' ? ask : ask.question
}

export function askOptions(ask: Ask): AskOption[] {
  return typeof ask === 'string' ? [] : ask.options
}

export function optionReply(option: AskOption): string {
  return option.reply !== undefined && option.reply !== '' ? option.reply : option.label
}

// replace only when the prompt box is empty, otherwise append
export function fillMode(draft: string): 'replace' | 'append' {
  return draft.trim() === '' ? 'replace' : 'append'
}
