const $ = (id) => document.getElementById(id)

// Everything capture + sync needs (read from the manifest so this can never
// drift from host_permissions). Chrome grants host_permissions at install so
// this is always satisfied there; Firefox MV3 treats host_permissions as
// OPTIONAL (nothing granted at install), so without this explicit grant the
// content scripts never inject and capture silently does nothing.
const REQUIRED_ORIGINS = chrome.runtime.getManifest().host_permissions

async function renderAccess() {
  const granted = await chrome.permissions.contains({ origins: REQUIRED_ORIGINS })
  $('access').hidden = granted
}

$('grant').addEventListener('click', async () => {
  const ok = await chrome.permissions.request({ origins: REQUIRED_ORIGINS })
  if (ok) $('status').textContent = 'Access granted. Reload any open AI tabs so capture starts.'
  renderAccess()
})

async function render() {
  const st = await chrome.runtime.sendMessage({ type: 'status' })
  const el = $('status')
  el.innerHTML = st.connected
    ? `<span class="dot on"></span> Connected · ${st.pending} event(s) pending sync`
    : `<span class="dot off"></span> Not connected`
  if (st.authError) el.innerHTML += `<br><span style="color:#a12a2a">${st.authError}</span>`
  $('setup').hidden = st.mode === 'code'
  $('connected').hidden = st.mode !== 'code'
  if (st.mode === 'code') $('email').textContent = st.email || 'your account'
  if (st.appOrigin && document.activeElement !== $('origin')) $('origin').value = st.appOrigin
}

// localhost/127.0.0.1 are OPTIONAL host permissions — they must be granted from
// a user gesture IN THE POPUP (the background can't prompt), or the background
// sync fetch to a local app is CORS-blocked. app.example.com is already in
// host_permissions, so production needs no prompt.
async function ensureLocalPermission(appOrigin) {
  const u = new URL(appOrigin)
  if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return true
  return chrome.permissions.request({ origins: [`http://${u.hostname}/*`] })
}

// Primary: connect-once pairing. Parse the code HERE so the localhost
// permission request happens inside this click gesture, then let the
// background redeem it (it re-validates the code independently).
$('connect').addEventListener('click', async () => {
  const code = $('code').value.trim()
  if (!code) return
  let parsed
  try { parsed = AppAuth.parseConnectCode(code) } catch (e) { $('status').textContent = e.message; return }
  if (!(await ensureLocalPermission(parsed.appOrigin))) {
    $('status').textContent = 'Local access was declined — sync to a local app needs it. Click Connect again to allow.'
    return
  }
  $('connect').disabled = true
  const r = await chrome.runtime.sendMessage({ type: 'connect', code })
  $('connect').disabled = false
  if (!r.ok) { $('status').textContent = r.error || 'Connect failed.'; return }
  $('code').value = ''
  render()
})

$('disconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'disconnect' })
  render()
})

// Legacy fallback: raw access token (expires ~hourly; kept for dev/testing).
function originOk(o) {
  try {
    const u = new URL(o)
    return u.origin === 'https://' + AppAuth.APP_HOST || u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  } catch { return false }
}
$('save').addEventListener('click', async () => {
  const appOrigin = $('origin').value.trim().replace(/\/$/, '')
  const accessToken = $('token').value.trim()
  if (!appOrigin || !accessToken) return
  if (!originOk(appOrigin)) { $('status').textContent = `App URL must be https://${AppAuth.APP_HOST} (or localhost for testing).`; return }
  try {
    if (!(await ensureLocalPermission(appOrigin))) {
      $('status').textContent = 'Local access was declined — sync to a local app needs it. Click Connect again to allow.'
      return
    }
  } catch { /* URL already validated by originOk */ }
  await chrome.storage.local.set({ aicompliance_config: { appOrigin, accessToken } })
  chrome.runtime.sendMessage({ type: 'refresh-config' }) // learn retention setting now
  $('token').value = ''
  render()
})

$('syncnow').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'sync-now' })
  $('status').textContent = r.ok ? `Synced ${r.uploaded ?? 0} event(s).` : `Sync failed: ${r.reason}`
  setTimeout(render, 1500)
})

render()
renderAccess()
