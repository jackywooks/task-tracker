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
  asks?: string[]
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
    }
  }
}
