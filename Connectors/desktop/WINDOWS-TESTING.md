# AI Compliance Logger — Windows test instructions

Build the installer with `npm run dist:win` (it lands in `release/`) and send it to the
tester with the steps below. They also need an AI Compliance account (invite them as staff from the app's Staff page) and a
reachable app URL.

## Install

1. Run **AI Compliance Logger Setup 0.2.1.exe**.
2. Windows SmartScreen will warn because the installer is not code-signed yet:
   click **More info → Run anyway**.
3. The app installs per-user (no admin rights needed), starts automatically,
   and lives in the **system tray** (bottom-right, near the clock — click the
   `^` chevron if Windows hides it). It also registers itself to start at login.

## Connect (once)

1. Sign in to the AI Compliance app in a browser → **Connections** → **Desktop
   logger** → **Generate connect code** → **Copy code**.
2. In the logger's Settings window (opens automatically on first run; later via
   tray icon → **Settings…**), paste the code into **Connect code** → **Connect**.
3. Status should flip to **watching · auto-refresh**. That's it — the code was
   one-time; the logger now keeps its own session and refreshes it forever.

## What it captures

Only **new** activity after the logger starts, from local AI agent transcripts:

| Source | Windows path |
|---|---|
| Claude Code (CLI / IDE) | `%USERPROFILE%\.claude\projects\**\*.jsonl` |
| Codex CLI | `%USERPROFILE%\.codex\sessions\**\rollout-*.jsonl` |
| Claude Desktop (agent mode) | `%APPDATA%\Claude\local-agent-mode-sessions\**\audit.jsonl` |

The tester needs at least one of those tools installed — the Settings window
shows **found / not installed** per source. WSL installs are NOT covered (their
transcripts live inside the WSL filesystem); use a native Windows install.

## Test script (5 minutes)

1. Connect as above; confirm **watching · auto-refresh**.
2. Run a short Claude Code (or Codex) prompt in a terminal.
3. Within ~30 seconds of the answer completing, the record appears in the web
   app under **Review records** (tray menu shows "Last sync HH:MM").
4. Quit the logger (tray → Quit), run another prompt, relaunch the logger —
   nothing is lost forward from launch, and queued events flush ~5s after start.
5. Reboot: the logger should come back on its own (login item) and keep syncing
   without re-pasting anything. This is the headline test — **connect once,
   stays connected**.

## Uninstall

Uninstall from **Settings → Apps → Installed apps → AI Compliance Logger → Uninstall**
(or Start menu → AI Compliance Logger → Uninstall). The uninstaller:

1. Closes the running tray app.
2. **Removes the autostart entry** so it no longer launches at login (verify:
   `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "AI Compliance Logger"`
   returns *not found* afterward).
3. Asks **"Also remove AI Compliance data stored on this PC?"** - choose **No** to keep
   any captured turns still queued for upload and your saved connection (default),
   or **Yes** to also delete `%APPDATA%\AI Compliance Logger` (queue + encrypted session).

Please confirm the autostart entry is gone and that "No" leaves the data folder
in place while "Yes" removes it.

## Honesty notes

- Windows is claimed only after this live run passes end-to-end (same rule as
  every other surface).
- Capture is hash-only unless the firm's admin turned on Content review.
- The logger is read-only: it never modifies the transcript files it watches.
