// Parse a single JSONL transcript line (Claude Code CLI *.jsonl and Claude
// Desktop audit.jsonl share the same shape: {type, uuid, message, timestamp}).
// message.content is either a plain string or an array of typed blocks.
//
// Capture semantics (what a reviewer signs off on):
//   - a "prompt" is a HUMAN user message (plain text). We deliberately skip
//     user lines that are tool_results fed back to the model (parent_tool_use_id
//     set, or a tool_result content block) — those are the agent's internal loop.
//   - an "output" is the assistant's TEXT blocks only (skip thinking + tool_use).

export interface ParsedLine {
  role: 'user' | 'assistant' | 'other'
  uuid: string | null
  ts: string | null
  model: string | null
  text: string
  isToolResult: boolean
  endsTurn: boolean // the assistant's response is complete -> flush the turn now
}

type Block = { type?: string; text?: string }

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is Block => !!b && typeof b === 'object')
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('')
  }
  return ''
}

function hasToolResultBlock(content: unknown): boolean {
  return Array.isArray(content) && content.some((b) => b && typeof b === 'object' && (b as Block).type === 'tool_result')
}

const OTHER: ParsedLine = { role: 'other', uuid: null, ts: null, model: null, text: '', isToolResult: false, endsTurn: false }

// terminal stop_reasons: the assistant's response is done (not an intermediate
// tool call), i.e. it's waiting for the human again.
const TERMINAL_STOP = new Set(['end_turn', 'stop_sequence', 'max_tokens'])

export function parseLine(line: string): ParsedLine | null {
  let o: Record<string, unknown>
  try { o = JSON.parse(line) } catch { return null }

  // Codex CLI rollout JSONL — a different shape. Use the event_msg stream, which
  // carries the ACTUAL human prompt (user_message) + the agent's final answer
  // (agent_message) as plain strings — no injected AGENTS.md, no tool loops (we
  // ignore the parallel response_item message stream to avoid double-counting).
  if (o.type === 'event_msg' && o.payload && typeof o.payload === 'object') {
    const p = o.payload as Record<string, unknown>
    const ts = (o.timestamp as string) || null
    const msg = typeof p.message === 'string' ? p.message : ''
    if (p.type === 'user_message') return { role: 'user', uuid: ts, ts, model: null, text: msg, isToolResult: false, endsTurn: false }
    if (p.type === 'agent_message') return { role: 'assistant', uuid: ts, ts, model: null, text: msg, isToolResult: false, endsTurn: false }
    // Codex writes task_complete when a run finishes -> flush the turn now (no idle wait)
    if (p.type === 'task_complete' || p.type === 'task_aborted') return { ...OTHER, ts, endsTurn: true }
    return OTHER
  }

  const type = o.type
  if (type !== 'user' && type !== 'assistant') return OTHER

  const msg = (o.message ?? {}) as Record<string, unknown>
  const content = msg.content
  const text = extractText(content)
  const isToolResult = !!o.parent_tool_use_id || hasToolResultBlock(content)
  const uuid = (o.uuid as string) || (msg.id as string) || null
  const ts = (o.timestamp as string) || (o._audit_timestamp as string) || null
  const model = (msg.model as string) || null
  // Claude Code / Desktop: an assistant line whose response completed (end_turn)
  // ends the turn — flush now instead of waiting for the next prompt / idle.
  const endsTurn = type === 'assistant' && TERMINAL_STOP.has(String(msg.stop_reason))

  return { role: type, uuid, ts, model, text, isToolResult, endsTurn }
}
