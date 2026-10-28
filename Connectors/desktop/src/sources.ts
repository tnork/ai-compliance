import { homedir } from 'node:os'
import { join } from 'node:path'

// The two on-disk transcript trees the logger watches. Both are JSONL; the
// parser normalizes their shared shape. Add a source here (root + match + label)
// to cover another local agent — no other code changes needed.
export interface Source {
  key: 'cli' | 'desktop' | 'codex'
  label: string
  root: string
  tool: string
  prefix: string // externalId namespace, prevents cross-source id collisions
  match: (path: string) => boolean
}

// Claude Desktop keeps its agent-mode sessions under the per-OS app-data dir;
// Claude Code and Codex use dot-dirs in the home dir on every OS.
function claudeDesktopRoot(home: string): string {
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions')
  if (process.platform === 'win32') return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'local-agent-mode-sessions')
  return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'Claude', 'local-agent-mode-sessions')
}

export function allSources(): Source[] {
  const home = homedir()
  return [
    {
      key: 'cli',
      label: 'Claude Code (CLI / IDE)',
      root: join(home, '.claude', 'projects'),
      tool: 'Claude Code',
      prefix: 'cc',
      match: (p) => p.endsWith('.jsonl'),
    },
    {
      key: 'desktop',
      label: 'Claude Desktop (agent mode)',
      root: claudeDesktopRoot(home),
      tool: 'Claude Desktop',
      prefix: 'cd',
      match: (p) => p.endsWith('audit.jsonl'),
    },
    {
      key: 'codex',
      label: 'Codex CLI',
      root: join(home, '.codex', 'sessions'),
      tool: 'Codex CLI',
      prefix: 'cx',
      // [^/\\] so the filename check holds under Windows path separators too
      match: (p) => /rollout-[^/\\]*\.jsonl$/.test(p),
    },
  ]
}
