// ISOLATED-world capture relay. Receives captured events from the MAIN-world
// injector, HASHES the prompt/output immediately (raw text never persists here;
// it is forwarded ONLY when the firm's content-retention setting is on), and
// hands the record to the background worker, which is the SINGLE WRITER for the
// buffer in chrome.storage.local. Content scripts never touch the buffer —
// concurrent tabs + the sync loop all mutate through one serialized queue in
// background.js, so a sync can't clobber an event a tab just captured (Codex P1).
// If the extension context is invalidated (extension reloaded/updated while the
// page is open), sendMessage AND storage would both be dead — reloading the page
// re-injects; nothing weaker than the old direct-write path is lost.

async function sha256Hex(s) {
  if (!s) return null
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
const bytes = (s) => (s ? new TextEncoder().encode(s).length : null)

let DEBUG = false
try { DEBUG = localStorage.getItem('aicompliance_debug') === '1' } catch {}

window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin) return
  const data = e.data
  if (!data || data.__aicompliance !== true || !data.event) return
  const ev = data.event
  if (DEBUG) console.log('[AI Compliance] content: received event', ev.tool, 'prompt?', !!ev.promptText, 'output?', !!ev.outputText)
  ;(async () => {
    // hash on capture — raw prompt/output text is discarded here unless the
    // firm's retention setting (refreshed by background.js) says to keep it
    const promptSha256 = await sha256Hex(ev.promptText)
    const outputSha256 = await sha256Hex(ev.outputText)
    if (!promptSha256 && !outputSha256) return // nothing worth logging
    const rec = {
      externalId: ev.externalId, tool: ev.tool, occurredAt: ev.occurredAt,
      promptSha256, promptBytes: bytes(ev.promptText),
      outputSha256, outputBytes: bytes(ev.outputText),
    }
    try {
      const { aicompliance_retain } = await chrome.storage.local.get('aicompliance_retain')
      if (aicompliance_retain) { rec.promptText = ev.promptText ?? null; rec.outputText = ev.outputText ?? null }
    } catch {}
    // Background persists (serialized), local-hash-chains, and arms the ~30s
    // debounce sync alarm. sendMessage wakes a terminated service worker and
    // queues until it's ready — as reliable as storage.local was from here.
    const resp = await chrome.runtime.sendMessage({ type: 'capture', rec })
    if (DEBUG) console.log('[AI Compliance] content: sent to background', resp)
  })().catch((err) => { if (DEBUG) console.log('[AI Compliance] content: capture relay failed', err) })
})
