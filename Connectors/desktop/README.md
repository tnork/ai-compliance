# AI Compliance Desktop Logger (v0.2)

Captures **local AI agent transcripts** — the surfaces the browser extension can't
reach — into your AI Compliance supervision record. An Electron tray app: macOS menubar
(live-proven) + Windows system tray (built + packaged 2026-07-13, awaiting its
first live end-to-end run before we claim it).

## What it captures
Read-only file watching of on-disk transcripts (no proxy, no injection, no
accessibility scraping):

| Source | Path | Tool label |
|---|---|---|
| Claude Code (CLI / IDE) | `~/.claude/projects/**/*.jsonl` | `Claude Code` |
| Claude Desktop (agent mode) | `~/Library/Application Support/Claude/local-agent-mode-sessions/**/audit.jsonl` | `Claude Desktop` |
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` | `Codex CLI` |

Codex rollout files use a different JSONL shape; the parser reads Codex's
`event_msg` stream (`user_message` = the human prompt, `agent_message` = the
answer) and ignores its parallel `response_item` stream to avoid double-counting.

A **turn** = a human prompt + the assistant's text reply. Internal tool loops
(tool-result user messages, thinking blocks, tool calls) are intentionally
excluded — a reviewer signs off on the actual prompt/answer, not the agent's
internal steps.

## How it works
- **Watch:** Node's recursive `fs.watch` over the source roots (macOS-native).
- **Tail:** incremental byte-offset reads; on first sight of a file we skip its
  existing content — only **new** activity after start is captured (no history
  backfill).
- **Ingest:** turns queue durably (survive restart/crash) and POST in byte-bounded
  batches to `POST /api/ingest` with `source: "desktop_agent"`. Events land
  `reviewed=false`, hash-chained, same pipeline as the browser extension. Only
  server-acked events leave the queue.
- **Sync cadence (v0.2):** event-driven — a captured turn schedules a sync ~30s
  out (re-armed per capture so bursts batch), plus a startup flush ~5s after
  launch and a 2-minute periodic retry backstop. A record shows up in the app
  about half a minute after the AI answered.
- **Auth (v0.2 — connect once, stays connected):** in the app go to
  **Connections → Desktop logger → Generate connect code** and paste the code
  into the logger's Settings. The code is a one-time Supabase magic-link
  token_hash; the logger redeems it for its **own** session (separate from your
  browser session, so refresh-token rotation never collides), persists it
  encrypted at rest via Electron `safeStorage` (Keychain / DPAPI), and
  self-refreshes from then on. No re-pasting. The old paste-an-access-token flow
  remains under Settings → Advanced as a dev fallback (expires ~hourly).
- **Content:** always sends `sha256` + byte length; includes **raw prompt/output
  text only when the firm has content-retention on** (re-checked server-side).
  Capture is full-fidelity: the complete prompt + answer, bounded only by the
  same 100,000-chars-per-field cap the extension and `/api/ingest` share.
  Data-minimization holds on disk too — raw text is never persisted locally when
  retention is off.

## Run (dev)
```bash
cd desktop
npm install
npm start          # builds (tsc) + launches Electron; menubar item appears
```
Open **Settings…** from the menubar → paste a **connect code** from the app's
Connections page (Desktop logger card) → Connect. Use Claude Code / Codex /
Claude Desktop, then watch records land under **Review records** ~30s later.

## Package (installers)
Installers are not committed; build them into `release/` (gitignored). To (re)build:
```bash
npm run dist:win   # Windows NSIS installer -> release/AI Compliance Logger Setup <ver>.exe (cross-builds on macOS; needs Rosetta 2)
npm run dist:mac   # macOS dmg (unsigned/un-notarized for now)
```
⚠️ On Apple Silicon, `dist:win` needs **Rosetta 2** (electron-builder runs an Intel
`wine64` for the rcedit version-stamp step; without it the build dies with
"bad CPU type in executable"). Install once: `softwareupdate --install-rosetta --agree-to-license`.
⚠️ If a build hangs at module-load with a 0-byte log, the iCloud-synced
`node_modules` is likely corrupted — `rm -rf node_modules node_modules.nosync && npm ci`
then restore the `mv node_modules node_modules.nosync && ln -s` layout, and rebuild.
The Windows installer is **not code-signed** — SmartScreen shows "Windows
protected your PC"; testers click More info → Run anyway. Per-user install, no
admin needed; registers a login item so it keeps syncing across reboots
(Settings → "Start automatically at login" to opt out). Share instructions for
testers: `WINDOWS-TESTING.md`.

## Planned sources
- **LM Studio (local LLMs — NEXT build item, 2026-07-11).** LM Studio persists
  every chat as its own local JSON file (macOS: `~/.cache/lm-studio/conversations`
  or the path "Reveal in Finder" shows) — a new `sources.ts` entry + a parser, the
  same tailing architecture as Claude/Codex. This covers ANY model run through LM
  Studio (DeepSeek, Qwen, Llama, etc.) since capture is per-app, not per-model.
  **Build gate:** LM Studio's file format is undocumented and officially "don't
  rely on it" — install LM Studio + generate a sample chat first, write the parser
  against the real shape, best-effort like the Gemini parser (format drift → emit
  nothing, never garbage). Tool label: `LM Studio`.
- **Deliberately descoped for now:** Ollama (server keeps no transcripts; CLI
  history is prompts-only — real capture needs an opt-in localhost proxy, a much
  bigger piece) and Chinese cloud web UIs (DeepSeek/Kimi/Qwen chat sites — browser-
  extension territory, not desktop). Un-loggable runtimes stay covered by the
  policy's device-exclusion clause + the coverage dashboard's visible-gap model.

## Roadmap order (founder-set, 2026-07-11)
1. LM Studio source (above)
2. Browser-extension smoke tests: Edge + Firefox (founder, live accounts)
3. Windows + Linux ports (below)

## Notes / limits (v0.2)
- **Windows port BUILT (2026-07-13):** per-OS transcript roots in `sources.ts`
  (Claude Code + Codex resolve via `os.homedir()` everywhere; Claude Desktop
  agent sessions at `%APPDATA%\Claude` on Windows / `~/.config/Claude` on
  Linux — verify against a real install before claiming the source), colored
  `.ico` tray icon (macOS template images don't exist on Windows), tooltip +
  double-click-opens-Settings, separator-safe path matching, login-item
  autostart. Recursive `fs.watch` is native on Windows. **UNPROVEN until a live
  end-to-end run on a real Windows machine** (real transcripts → synced
  records) — same honesty rule as every surface. WSL installs are not covered
  (transcripts live inside the WSL filesystem).
- **Linux still pending (gated on Windows proving out first):** the source is
  platform-aware by fall-through (`sources.ts` paths, `ingest.ts` `os:'linux'`,
  `tray.png`) but there is **no `linux` electron-builder target / `dist:linux`
  script and it has never been built or run on Linux.** Recursive `fs.watch`
  needs a live sanity-check (native on macOS/Windows; landed in the Node 20 that
  Electron 33 bundles - unverified here), plus inotify watch limits and
  appindicator tray packaging. Do NOT build/prove Linux until the live Windows
  run passes - one unproven platform at a time.
- The 0600 config/state file mode is a POSIX no-op on Windows — per-user
  `%APPDATA%` ACLs are the boundary there; the session itself is
  safeStorage-encrypted (DPAPI) either way.
- macOS build is not yet signed/notarized — run from source on Mac, or build
  the dmg for personal use.
- Claude Desktop's *main chat* (non-agent) lives in a Chromium IndexedDB and is
  not covered here; use claude.ai in the browser (extension) for that.
