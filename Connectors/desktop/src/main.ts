import { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage, shell } from 'electron'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Store } from './store'
import { Ingest, type Status } from './ingest'
import { Tailer } from './tailer'
import { allSources, type Source } from './sources'
import { APP_HOST, isAllowedOrigin, parseConnectCode, redeemConnectCode } from './auth'

const SYNC_INTERVAL_MS = 2 * 60 * 1000 // periodic drain — retry backstop
const SYNC_SOON_MS = 30 * 1000 // event-driven: sync ~30s after a captured turn (re-armed per capture so bursts batch)
const DEBOUNCE_MS = 400 // coalesce fs.watch bursts per file
// Tray icon per platform: macOS gets a monochrome TEMPLATE of the AI Compliance shield
// (renders white on the dark bar / black on light, like the system glyphs);
// Windows gets the colored .ico, Linux the colored .png — template images are a
// macOS-only concept.
function trayIcon() {
  if (process.platform === 'darwin') {
    const img = nativeImage.createFromPath(join(__dirname, 'assets', 'trayTemplate.png'))
    img.setTemplateImage(true)
    return img
  }
  if (process.platform === 'win32') return nativeImage.createFromPath(join(__dirname, 'assets', 'tray.ico'))
  return nativeImage.createFromPath(join(__dirname, 'assets', 'tray.png'))
}

const DEBUG = process.argv.includes('--dev') || process.env.AIC_DEBUG === '1'
const dlog = (...a: unknown[]) => { if (DEBUG) console.log('[aic]', ...a) }

// Test hook: point config/state at a throwaway dir so E2E runs never touch a
// real install's connection or queue.
if (process.env.AIC_USER_DATA) app.setPath('userData', process.env.AIC_USER_DATA)

const store = new Store()
let tray: Tray | null = null
let prefsWin: BrowserWindow | null = null
let lastStatus: Status = { pending: 0, retainRaw: false }
const watchers: FSWatcher[] = []
const debounces = new Map<string, NodeJS.Timeout>()

const ingest = new Ingest(store, (s) => { lastStatus = s; refreshTray(); pushStatus() })

// Event-driven sync: ~30s after a turn is captured (re-armed per capture so a
// burst uploads as one batch), same cadence as the browser extension. The
// periodic interval below stays as the retry backstop.
let syncSoonTimer: NodeJS.Timeout | null = null
function syncSoon(ms = SYNC_SOON_MS) {
  if (syncSoonTimer) clearTimeout(syncSoonTimer)
  syncSoonTimer = setTimeout(() => { syncSoonTimer = null; ingest.sync() }, ms)
}

const tailer = new Tailer(store, toolFor, prefixFor, (t) => {
  // "Pause capture" means STOP recording: drop turns produced while paused (the
  // file offset still advances, so resuming does NOT backfill the paused window —
  // a paused period is an honest gap, not deferred capture).
  if (store.config.paused) { dlog('paused — dropped turn', t.externalId); return }
  dlog('turn captured:', t.tool, t.externalId, `prompt=${t.promptText.length} output=${t.outputText.length}`)
  ingest.enqueue(t)
  syncSoon()
})

function activeSources(): Source[] {
  return allSources().filter((s) => store.config.sources[s.key] !== false)
}
function sourceOf(path: string): Source | undefined {
  return allSources().find((s) => path.startsWith(s.root) && s.match(path))
}
function toolFor(path: string) { return sourceOf(path)?.tool ?? 'Desktop AI' }
function prefixFor(path: string) { return sourceOf(path)?.prefix ?? 'dt' }

function scheduleChange(path: string) {
  dlog('change:', path)
  const prev = debounces.get(path)
  if (prev) clearTimeout(prev)
  debounces.set(path, setTimeout(() => { debounces.delete(path); tailer.onChange(path).catch((e) => dlog('onChange err', String(e))) }, DEBOUNCE_MS))
}

async function scanExisting(src: Source) {
  try {
    const entries = await readdir(src.root, { recursive: true }) as string[]
    for (const rel of entries) {
      const full = join(src.root, rel)
      // prime() pins EXISTING files to current size (new-only, no history
      // backfill). Files created later fire a watch event and are read from 0,
      // so a session started after the logger keeps its first prompt.
      if (src.match(full)) await tailer.prime(full)
    }
  } catch { /* root may not exist (e.g. no Claude Desktop) */ }
}

function startWatching() {
  for (const w of watchers.splice(0)) { try { w.close() } catch {} }
  for (const src of activeSources()) {
    if (!existsSync(src.root)) { dlog('source root missing:', src.key, src.root); continue }
    dlog('watching:', src.key, src.root)
    scanExisting(src)
    try {
      const w = watch(src.root, { recursive: true }, (_e, filename) => {
        if (!filename) return
        const full = join(src.root, filename.toString())
        if (src.match(full)) scheduleChange(full)
      })
      watchers.push(w)
    } catch (e) { dlog('watch failed:', src.key, String(e)) }
  }
}

function connState(): 'off' | 'ready' | 'paused' | 'unconfigured' {
  if (!store.config.appOrigin || (!store.session && !store.config.token)) return 'unconfigured'
  if (store.config.paused) return 'paused'
  return 'ready'
}

function refreshTray() {
  if (!tray) return
  const st = connState()
  // macOS: icon carries the brand; append only a status glyph when not actively
  // watching. Other platforms have no tray title — status lives in the tooltip.
  if (process.platform === 'darwin') tray.setTitle(st === 'ready' ? '' : st === 'paused' ? ' ⏸' : ' ⚠')
  const pending = lastStatus.pending
  const headline = st === 'unconfigured' ? 'Not connected — open settings' : st === 'paused' ? 'Paused' : `Watching · ${pending} pending`
  tray.setToolTip(`AI Compliance Logger — ${headline}`)
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: headline, enabled: false },
    ...(store.session?.email ? [{ label: `Connected as ${store.session.email}`, enabled: false } as Electron.MenuItemConstructorOptions] : []),
    lastStatus.lastError ? { label: `⚠ ${lastStatus.lastError}`, enabled: false } : { label: lastStatus.lastSyncAt ? `Last sync ${new Date(lastStatus.lastSyncAt).toLocaleTimeString()}` : 'Not synced yet', enabled: false },
    { label: `Content: ${lastStatus.retainRaw ? 'retained (encrypted)' : 'hash-only'}`, enabled: false },
    { type: 'separator' },
    { label: store.config.paused ? 'Resume capture' : 'Pause capture', click: () => { store.config.paused = !store.config.paused; store.saveConfig(); refreshTray(); pushStatus() } },
    { label: 'Sync now', enabled: st !== 'unconfigured', click: () => ingest.sync() },
    { label: 'Settings…', click: openPrefs },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]
  tray.setContextMenu(Menu.buildFromTemplate(items))
}

function openPrefs() {
  if (prefsWin) { prefsWin.show(); prefsWin.focus(); return }
  prefsWin = new BrowserWindow({
    width: 520, height: 640, resizable: false, fullscreenable: false, title: 'AI Compliance Logger',
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  prefsWin.loadFile(join(__dirname, 'ui', 'preferences.html'))
  prefsWin.on('closed', () => { prefsWin = null })
}

function pushStatus() {
  prefsWin?.webContents.send('state', currentState())
}
function currentState() {
  return {
    config: store.config,
    // session tokens never cross into the renderer — only what the UI shows
    connection: store.session
      ? { mode: 'code' as const, email: store.session.email }
      : store.config.token ? { mode: 'legacy' as const, email: null } : { mode: 'none' as const, email: null },
    status: lastStatus,
    sources: allSources().map((s) => ({ key: s.key, label: s.label, present: existsSync(s.root) })),
  }
}

// ---- IPC (preferences window) ----
ipcMain.handle('get-state', () => currentState())
ipcMain.handle('save-config', (_e, patch: Partial<typeof store.config>) => {
  // Reject a bad app origin so the bearer token is never sent to an arbitrary host.
  if (typeof patch.appOrigin === 'string' && patch.appOrigin.trim() && !isAllowedOrigin(patch.appOrigin.trim())) {
    return { ...currentState(), originError: `App URL must be https://${APP_HOST} (or http://localhost:PORT for dev).` }
  }
  const before = JSON.stringify(store.config.sources)
  store.config = { ...store.config, ...patch, sources: { ...store.config.sources, ...(patch.sources || {}) } }
  store.saveConfig()
  if (typeof patch.launchAtLogin === 'boolean') applyLoginItem()
  if (JSON.stringify(store.config.sources) !== before) startWatching()
  refreshTray()
  return currentState()
})
// Pair with a connect code from the app's Connections page: one-time exchange
// for this device's own self-refreshing session. Replaces any legacy token.
ipcMain.handle('connect-code', async (_e, raw: string) => {
  try {
    const code = parseConnectCode(String(raw ?? ''))
    const creds = await redeemConnectCode(code)
    store.config.appOrigin = code.appOrigin
    store.config.token = ''
    store.setSession(creds)
    refreshTray()
    ingest.sync()
    return { ...currentState(), connected: true }
  } catch (e) {
    return { ...currentState(), connectError: e instanceof Error ? e.message : String(e) }
  }
})
ipcMain.handle('disconnect', () => {
  store.setSession(null)
  store.config.token = ''
  store.saveConfig()
  refreshTray()
  return currentState()
})
ipcMain.handle('sync-now', async () => { const r = await ingest.sync(); return { result: r, state: currentState() } })
ipcMain.handle('open-external', (_e, url: string) => { if (/^https?:\/\//.test(url)) shell.openExternal(url) })

// ---- lifecycle ----
if (!app.requestSingleInstanceLock()) { app.quit() }
app.on('second-instance', openPrefs)

// Tray app that should keep syncing across reboots: register as a login item
// (packaged builds only — a dev checkout shouldn't autostart).
function applyLoginItem() {
  if (!app.isPackaged) return
  const openAtLogin = store.config.launchAtLogin !== false
  try {
    // On Windows, pin the registry value name so the uninstaller can delete the
    // autostart entry deterministically (build/installer.nsh removes exactly this
    // HKCU Run value). Elsewhere Electron's default login-item handling is fine.
    app.setLoginItemSettings(process.platform === 'win32' ? { openAtLogin, name: 'AI Compliance Logger' } : { openAtLogin })
  } catch (e) { dlog('login item failed', String(e)) }
}

app.whenReady().then(() => {
  app.dock?.hide() // menubar app, no dock icon (macOS; no-op elsewhere)
  store.load()
  lastStatus = ingest.getStatus()
  tray = new Tray(trayIcon())
  if (process.platform !== 'darwin') tray.on('double-click', openPrefs)
  refreshTray()
  applyLoginItem()
  startWatching()
  if (connState() === 'unconfigured') openPrefs()
  syncSoon(5_000) // startup flush: drain anything queued while the app was closed
  setInterval(() => ingest.sync(), SYNC_INTERVAL_MS)
})

app.on('window-all-closed', () => { /* stay alive in the menubar */ })
