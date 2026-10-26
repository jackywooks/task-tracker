// doing: being worked on · waiting: needs the user (a question to answer / something to merge) · blocked: waits on someone else · done · todo: not started
export type TopicStatus = 'doing' | 'waiting' | 'blocked' | 'done' | 'todo'

// A topic is one thing worked on this session; one line when collapsed, full context when expanded
export type Topic = {
  id: string
  title: string
  status: TopicStatus
  line?: string
  background?: string
  decided?: string[]
  outputs?: string[]
  pending?: string[]
  asks?: Ask[]
}

// An option button under a question: label is shown, reply (default: label) is the exact text put in the prompt box
export type AskOption = { label: string; reply?: string }

// A question for the user: a plain string, or a question with option buttons
export type Ask = string | { question: string; options: AskOption[] }

// A link kept at session level: a URL under test (note) or something created this session (kind: issue / pr / page ...; parent: the url of the epic / parent issue a sub-issue hangs under)
export type SessionLink = {
  label: string
  url: string
  note?: string
  kind?: string
  parent?: string
  topic?: string
}

// A change left on this machine that outlives the session; cleanup marks one that still has to be cleaned up
export type LocalChange = {
  label: string
  detail?: string
  path?: string
  cleanup?: boolean
}

export type AgentRunStatus = 'running' | 'done' | 'aborted' | 'error'

export type AgentRun = {
  key: string
  agentId?: string
  topic?: string
  description: string
  type: string
  model: string
  background: boolean
  startedAt: number
  endedAt?: number
  status: AgentRunStatus
  tools: number
  lastTool?: string
  report?: string
  summary?: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'task-tracker': {
      topics: Topic[]
      now: string
      updatedAt: string
      expanded: string[]
      agents: AgentRun[]
      summary: string
      testing: SessionLink[]
      created: SessionLink[]
      merges: SessionLink[]
      changes: LocalChange[]
      closedMerges: string[]
      flipped: string[]
      copied: string
      parkedTick: number
      parkedFlipped: string[]
    }
  }
}
