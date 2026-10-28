import { promises as fs } from 'node:fs'
import { parseLine } from './parser'
import type { Turn } from './types'
import type { Store } from './store'

const IDLE_FLUSH_MS = 15_000 // a turn is "done" once its file goes quiet this long

interface Pending { promptText: string; promptUuid: string; ts: string; model: string | null; output: string }
interface FileState { offset: number; cur: Pending | null; idle: NodeJS.Timeout | null }

// Incrementally reads appended JSONL and assembles human-prompt -> assistant-text
// turns. On FIRST sight of a file we skip its existing content (new-only capture,
// no giant backfill of history). A turn flushes when the next human prompt starts
// OR the file goes idle (covers the last turn in a session).
export class Tailer {
  private files = new Map<string, FileState>()

  constructor(
    private store: Store,
    private toolFor: (path: string) => string,
    private prefixFor: (path: string) => string,
    private emit: (t: Turn) => void,
  ) {}

  // Startup scan: pin EXISTING files to their current size so we don't backfill
  // old sessions (new-only). Only the first ever sight sets this; on restart the
  // persisted offset wins (so content written while we were down isn't skipped).
  async prime(path: string) {
    if (this.store.getOffset(path) !== undefined) return
    let size = 0
    try { size = (await fs.stat(path)).size } catch { size = 0 }
    this.store.setOffset(path, size)
  }

  private async ensure(path: string): Promise<FileState> {
    let st = this.files.get(path)
    if (st) return st
    // Unknown at onChange time = a file CREATED while we're running (a new
    // session). Start from 0 so its first prompt isn't lost. Files that existed
    // at startup were pinned by prime() and won't hit this branch.
    let off = this.store.getOffset(path)
    if (off === undefined) { off = 0; this.store.setOffset(path, off) }
    st = { offset: off, cur: null, idle: null }
    this.files.set(path, st)
    return st
  }

  async onChange(path: string) {
    const st = await this.ensure(path)
    let size = 0
    try { size = (await fs.stat(path)).size } catch { return }
    if (size < st.offset) st.offset = 0 // truncated / rotated -> re-read from start
    if (size <= st.offset) return

    let text: string
    try {
      const fh = await fs.open(path, 'r')
      const buf = Buffer.alloc(size - st.offset)
      await fh.read(buf, 0, buf.length, st.offset)
      await fh.close()
      text = buf.toString('utf8')
    } catch { return }

    const lastNl = text.lastIndexOf('\n')
    if (lastNl === -1) return // no complete line yet — leave offset, wait for more
    st.offset += Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8')

    for (const line of text.slice(0, lastNl).split('\n')) {
      if (line.trim()) this.consume(path, st, line)
    }
    // Persist the advanced offset ONLY AFTER the emitted turns are enqueued (each
    // enqueue persists the queue). If we crash mid-loop, the offset isn't yet
    // advanced -> those lines are re-read and re-assembled next start (the seen-set
    // dedups already-enqueued turns), so no transcript line is silently skipped.
    this.store.setOffset(path, st.offset)
    this.resetIdle(path, st)
  }

  private consume(path: string, st: FileState, line: string) {
    const p = parseLine(line)
    if (!p) return
    if (p.role === 'user' && !p.isToolResult && p.text.trim()) {
      if (st.cur && st.cur.output.trim()) this.flush(path, st)
      st.cur = { promptText: p.text, promptUuid: p.uuid || `${path}:${st.offset}`, ts: safeTs(p.ts), model: p.model, output: '' }
    } else if (p.role === 'assistant' && st.cur) {
      if (p.text) st.cur.output += p.text
      if (p.model && !st.cur.model) st.cur.model = p.model
    }
    // Response complete (Claude end_turn / Codex task_complete) -> flush NOW so a
    // sync right after a chat has the current turn, not the previous one. Append
    // happened above first, so the flushed turn includes this line's text.
    if (p.endsTurn) this.flush(path, st)
    // tool_result users, thinking/tool_use blocks, and other line types are not
    // part of the prompt/output — they just keep the turn open (idle-timer reset).
  }

  private flush(path: string, st: FileState) {
    const c = st.cur
    st.cur = null
    if (!c || !c.output.trim()) return
    this.emit({
      externalId: `${this.prefixFor(path)}:${c.promptUuid}`,
      tool: this.toolFor(path),
      model: c.model,
      occurredAt: c.ts,
      promptText: c.promptText,
      outputText: c.output,
    })
  }

  private resetIdle(path: string, st: FileState) {
    if (st.idle) clearTimeout(st.idle)
    st.idle = setTimeout(() => this.flush(path, st), IDLE_FLUSH_MS)
  }
}

function safeTs(ts: string | null): string {
  const t = ts ? Date.parse(ts) : NaN
  const now = Date.now()
  if (!Number.isFinite(t) || t > now + 864e5 || t < now - 45 * 864e5) return new Date(now).toISOString()
  return new Date(t).toISOString()
}
