// MAIN-world capture: monkey-patch window.fetch at document_start so it wraps
// the AI app's OWN network calls (never passive DOM scraping). For a matched
// conversation endpoint we tee the response — one branch to the page (UX
// unbroken), one parsed for the assistant output — and read the prompt from the
// request body. Captured events are postMessage'd to the ISOLATED content
// script, which buffers + syncs. Provider payload shapes drift; the per-host
// parsers below are best-effort and need tuning against live payloads.
//
// DEBUG: run `localStorage.aicompliance_debug='1'` in the page console and reload to
// log every fetch URL, and for matched turns the request-body + response-stream
// samples + what got extracted. That's the data we use to fix a mis-parse.
(() => {
  const HOST = location.host
  let DEBUG = false
  try { DEBUG = localStorage.getItem('aicompliance_debug') === '1' } catch {}
  const log = (...a) => { if (DEBUG) console.log('[AI Compliance]', ...a) }

  const MATCH = {
    tool:
      HOST.includes('claude.ai') ? 'Claude' :
      HOST.includes('grok.com') ? 'Grok' :
      HOST.includes('gemini.google') ? 'Gemini' :
      (HOST.includes('copilot') || HOST.includes('cloud.microsoft')) ? 'Copilot' : 'ChatGPT',
    isTurn: (url) =>
      // ChatGPT fires speculative `/f/conversation/prepare` prefetches that carry NO
      // message and return only a `conduit_token` - never a real turn. Excluding them
      // removes the misleading "MATCHED TURN -> NULL" noise; the real answer-bearing
      // turn is `/backend-api/f/conversation` (no /prepare), captured over fetch/SSE.
      !/\/prepare\b/.test(url) && (
        /\/backend-api\/(f\/)?conversation\b/.test(url) ||     // ChatGPT (+ the f/ variant)
        /\/chat_conversations\/.+\/completion\b/.test(url) ||  // Claude
        /\/conversations?\/.+\/(responses|completion)\b/.test(url) || // Grok (approx)
        /BardChatUi\/data\/batchexecute/i.test(url) ||        // Gemini (main-thread XHR batchexecute; parse-success filters non-chat RPCs)
        /copilot|substrate|sydney|turing|m365.*chat/i.test(url) ||          // Copilot (approx)
        /\/(chat|conversation|responses|completion)s?\b/i.test(url)          // broad fallback
      ),
  }

  function extractPrompt(body) {
    if (!body) return null
    try {
      const o = typeof body === 'string' ? JSON.parse(body) : body
      // ChatGPT: {messages:[{author:{role},content:{parts:[]}}]}
      if (Array.isArray(o.messages)) {
        const last = [...o.messages].reverse().find((m) => (m.author?.role ?? m.role) === 'user')
        const c = last?.content
        if (Array.isArray(c?.parts)) return c.parts.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('\n')
        if (typeof c === 'string') return c
        if (typeof last?.text === 'string') return last.text
      }
      if (typeof o.prompt === 'string') return o.prompt
      // Claude: {prompt} or {messages}; Grok: {message}
      if (typeof o.message === 'string') return o.message
      if (o.input && typeof o.input === 'string') return o.input
    } catch {}
    return null
  }

  // Pull assistant text from an SSE/NDJSON stream. Handles: OpenAI-style delta,
  // Claude content_block_delta, full-snapshot {message:{content:{parts}}}, and
  // ChatGPT's compact JSON-patch delta protocol.
  function extractOutput(raw) {
    let out = ''
    let snapshot = ''
    // ChatGPT compact protocol state. Ops arrive three ways and ALL must be
    // handled or chunks of the answer are silently lost (seen live 2026-07-11:
    // answers missing their head + mid-stream gaps):
    //   {p:"/message/content/parts/0", o:"append", v:"text"}   single op
    //   {v:"text"}                                             bare = repeat last op
    //   {o:"patch", v:[{p,o,v}, ...]}                          BATCHED ops
    //   {p:"", o:"add", v:{message:{...}}}                     new message envelope
    // Reasoning models stream a thoughts message before the answer message, so
    // text is accumulated per message and the last text-type message wins.
    const msgs = []   // completed message texts, stream order
    let cur = null    // { ignore, parts: Map(path -> text), last }
    const curText = () => (cur && !cur.ignore ? [...cur.parts.values()].join('') : '')
    const beginMessage = (m) => {
      const t = curText(); if (t) msgs.push(t)
      const ct = m?.content?.content_type
      cur = { ignore: !!(ct && ct !== 'text'), parts: new Map(), last: null }
      const parts = m?.content?.parts
      if (Array.isArray(parts)) parts.forEach((x, i) => { if (typeof x === 'string' && x) cur.parts.set(`/message/content/parts/${i}`, x) })
    }
    const applyOp = (op) => {
      if (!op || typeof op !== 'object') return
      if (Array.isArray(op.v)) { op.v.forEach(applyOp); return }          // batched patch
      if (op.v && typeof op.v === 'object' && op.v.message) { beginMessage(op.v.message); return }
      if (typeof op.v !== 'string') return
      const explicit = typeof op.p === 'string' && op.p !== ''
      const path = explicit ? op.p : (cur?.last ?? '/message/content/parts/0')
      if (explicit && !path.includes('/parts')) return                    // metadata/status patch, not answer text
      if (!cur) cur = { ignore: false, parts: new Map(), last: null }
      cur.last = path
      if (!explicit || op.o === 'append' || op.o === undefined) cur.parts.set(path, (cur.parts.get(path) || '') + op.v)
      else cur.parts.set(path, op.v)                                      // add/set/replace = authoritative rewrite
    }
    for (const line of raw.split('\n')) {
      const s = line.replace(/^data:\s*/, '').trim()
      if (!s || s === '[DONE]') continue
      let o
      try { o = JSON.parse(s) } catch { continue }
      // classic streaming deltas
      const delta =
        o.delta?.text ??                              // Anthropic content_block_delta
        o.choices?.[0]?.delta?.content ??             // OpenAI chat.completions
        o.completion                                  // legacy
      if (typeof delta === 'string') { out += delta; continue }
      // full snapshot (older ChatGPT): {message:{content:{parts:[...]}}}
      const parts = o.message?.content?.parts
      if (Array.isArray(parts)) snapshot = parts.map((p) => (typeof p === 'string' ? p : '')).join('')
      // ChatGPT compact delta protocol (all shapes) → stateful handler above
      if (o.v !== undefined) applyOp(o)
      // Grok (grok.com /rest/app-chat): NDJSON, one {"result":{...}} per line.
      // Assistant tokens stream as {"result":{"response":{"token":"...","isThinking":bool}}}
      // (or {"result":{"token":"..."}}); the final line carries the full text in
      // {"result":{"response":{"modelResponse":{"message":"..."}}}}. Skip thinking tokens.
      const gr = o.result?.response ?? o.result
      if (gr && typeof gr === 'object') {
        if (typeof gr.token === 'string' && !gr.isThinking) out += gr.token
        const full = gr.modelResponse?.message ?? o.result?.response?.modelResponse?.message
        if (typeof full === 'string' && full) snapshot = full
      }
    }
    const t = curText(); if (t) msgs.push(t)
    // Join ALL text-type messages (thoughts were excluded per-message): a long
    // answer can span continuation messages, and for an evidence record a rare
    // duplicate beats a missing chunk.
    const compact = msgs.filter(Boolean).join('')
    return (compact || out || snapshot) || null
  }

  // Gemini (google) doesn't stream deltas or put the prompt in the request. Its
  // batchexecute response for the conversation-content RPC (hNvQHb) returns the
  // full turn list as a nested array. We pull the NEWEST turn's prompt + answer +
  // its stable rc_ id (used as the dedup key). Best-effort: Google's positional
  // array format is undocumented and drifts — if the shape moves, we extract
  // nothing rather than emit garbage. Returns {prompt, output, externalId} | null.
  function parseGeminiTurn(raw) {
    try {
      const body = raw.replace(/^\)\]\}'\s*/, '')
      let payload = null
      for (const line of body.split('\n')) {
        const t = line.trim()
        if (!t.startsWith('[[')) continue
        let arr
        try { arr = JSON.parse(t) } catch { continue }
        for (const entry of (Array.isArray(arr) ? arr : [])) {
          // ["wrb.fr","hNvQHb","<inner-json-string>", ...]
          if (Array.isArray(entry) && entry[0] === 'wrb.fr' && entry[1] === 'hNvQHb' && typeof entry[2] === 'string') {
            try { payload = JSON.parse(entry[2]) } catch {}
          }
        }
      }
      if (!payload) return null
      const turns = Array.isArray(payload[0]) ? payload[0] : null
      if (!turns || !turns.length) return null
      const turn = turns[0] // newest-first
      const convId = turn?.[0]?.[0] || ''
      const prompt = turn?.[2]?.[0]?.[0]
      const rc = turn?.[3]?.[0]?.[0]?.[0]
      const output = turn?.[3]?.[0]?.[0]?.[1]?.[0]
      if (typeof prompt !== 'string' || typeof output !== 'string') return null
      return { prompt, output, externalId: `gemini:${convId}:${rc || prompt.length}` }
    } catch { return null }
  }

  const orig = window.fetch
  window.fetch = async function (...args) {
    const req = args[0]
    const method = (args[1]?.method ?? (typeof req !== 'string' ? req?.method : 'GET') ?? 'GET').toUpperCase()
    const url = typeof req === 'string' ? req : (req?.url ?? '')
    const isTurn = MATCH.isTurn(url) && method === 'POST'
    if (DEBUG && method === 'POST') log('fetch', method, url, isTurn ? '← MATCH' : '')
    let prompt = null, bodySample = null
    if (isTurn) {
      try {
        const body = args[1]?.body ?? (typeof req !== 'string' ? await req.clone().text() : null)
        if (DEBUG && typeof body === 'string') bodySample = body.slice(0, 2000)
        prompt = extractPrompt(body)
      } catch (e) { log('prompt read failed', e) }
    }
    const res = await orig.apply(this, args)
    if (!isTurn || !res.body) return res

    // Read a CLONE in the background and return the ORIGINAL response untouched —
    // never hand the page a rewrapped Response (that can break its stream handling).
    let clone = null
    try { clone = res.clone() } catch (e) { log('clone failed', e) }
    if (clone?.body) (async () => {
      // `raw` lives OUTSIDE the try: Firefox propagates the page's AbortController
      // cleanup (fired after IT finished reading) into our cloned branch, so the
      // reader throws "The operation was aborted" even though every byte already
      // arrived. Dropping the buffer there loses the whole answer - so on ANY read
      // error we still parse what we accumulated. A genuine mid-stream abort (user
      // hit stop) then yields exactly what the model actually produced.
      let raw = ''
      let aborted = false
      try {
        const reader = clone.body.getReader(); const dec = new TextDecoder()
        for (;;) { const { done, value } = await reader.read(); if (done) break; raw += dec.decode(value, { stream: true }) }
      } catch (e) { aborted = true; log('stream read interrupted (salvaging buffer)', e) }
      try {
        const output = extractOutput(raw)
        if (DEBUG) {
          log('MATCHED TURN', url, aborted ? '(stream interrupted - salvaged)' : '')
          log('  request body sample:', bodySample)
          log('  response bytes buffered:', raw.length)
          log('  response stream sample:', raw.slice(0, 6000))
          log('  extracted prompt:', prompt ? `(${prompt.length} chars) ${prompt.slice(0, 120)}` : 'NULL')
          log('  extracted output:', output ? `(${output.length} chars) ${output.slice(0, 120)}` : 'NULL')
        }
        // On a clean read, emit normally. On an ABORT, only emit if we actually
        // salvaged an answer - otherwise an early failure (immediate network error /
        // pre-answer cancel) would post a prompt-only "turn" as though it completed,
        // which is misleading supervision evidence. The Firefox all-bytes-then-abort
        // case has output, so it still emits. (emit() also guards prompt||output.)
        if (!aborted || output) emit(url, prompt, output)
        else log('aborted with no output - not emitting (incomplete turn)')
      } catch (e) { log('parse failed', e) }
    })()
    return res // original, untouched — the page's stream handling is never altered
  }
  // Post a captured turn to the content script (shared by the fetch + XHR paths).
  function emit(url, prompt, output, externalId) {
    if (!(prompt || output)) return
    window.postMessage({
      __aicompliance: true,
      event: {
        externalId: externalId || `${HOST}:${Date.now()}:${Math.round(performance.now())}`,
        tool: MATCH.tool,
        occurredAt: new Date().toISOString(),
        promptText: prompt,
        outputText: output,
      },
    }, location.origin)
    log('posted event to content script')
  }

  // Some apps send the conversation over XHR, not fetch — notably Google/Gemini's
  // batchexecute (BardChatUi) RPC. Tee XHR the same way: capture method+url at
  // open(), read the request body at send(), and parse responseText on load. The
  // original request is never altered (we only observe). Guarded so a failure here
  // can't break the page or the fetch path.
  try {
    const RealXHR = window.XMLHttpRequest
    if (RealXHR && RealXHR.prototype) {
      const origOpen = RealXHR.prototype.open
      const origSend = RealXHR.prototype.send
      RealXHR.prototype.open = function (method, url) {
        try { this.__aic = { method: String(method || 'GET').toUpperCase(), url: String(url || '') } } catch {}
        return origOpen.apply(this, arguments)
      }
      RealXHR.prototype.send = function (body) {
        try {
          const meta = this.__aic
          if (meta) {
            const isTurn = MATCH.isTurn(meta.url) && meta.method === 'POST'
            if (DEBUG && meta.method === 'POST') log('xhr', meta.method, meta.url, isTurn ? '← MATCH' : '')
            if (isTurn) {
              const bodyStr = typeof body === 'string' ? body : null
              this.addEventListener('load', () => {
                try {
                  let raw = ''
                  try { raw = this.responseText || '' } catch { raw = '' } // responseType!=text throws
                  // Gemini's prompt+answer both live in the response (batchexecute
                  // conversation RPC); every other provider = request prompt + response output.
                  let prompt, output, extId
                  if (MATCH.tool === 'Gemini') {
                    const g = parseGeminiTurn(raw)
                    if (g) { prompt = g.prompt; output = g.output; extId = g.externalId }
                  } else {
                    prompt = extractPrompt(bodyStr)
                    output = extractOutput(raw)
                  }
                  if (DEBUG) {
                    log('MATCHED TURN (xhr)', meta.url)
                    log('  request body sample:', bodyStr ? bodyStr.slice(0, 2000) : '(non-string body)')
                    log('  response sample:', raw.slice(0, 6000))
                    log('  extracted prompt:', prompt ? `(${prompt.length} chars) ${prompt.slice(0, 120)}` : 'NULL')
                    log('  extracted output:', output ? `(${output.length} chars) ${output.slice(0, 120)}` : 'NULL')
                  }
                  emit(meta.url, prompt, output, extId)
                } catch (e) { log('xhr read failed', e) }
              })
            }
          }
        } catch (e) { log('xhr send hook failed', e) }
        return origSend.apply(this, arguments)
      }
      log('capture installed on', HOST, '(fetch + XHR patched)')
    } else {
      log('capture installed on', HOST, '(fetch patched; no XHR)')
    }
  } catch (e) { log('XHR patch failed', e); log('capture installed on', HOST, '(fetch patched)') }

  // DEBUG only: some providers (notably Copilot) stream over WebSocket, which the
  // fetch tee can't observe. Log incoming text frames so the debug session tells
  // us the transport (fetch vs WS) and the payload shape to parse. This runs AFTER
  // the fetch patch is installed and is fully guarded — a failure here must never
  // take down fetch capture (that was a ChatGPT-capture regression).
  try {
    if (DEBUG && window.WebSocket) {
      const OrigWS = window.WebSocket
      const dump = (dir, d) => {
        if (typeof d === 'string') { if (d.length > 2) log(dir, 'str', d.slice(0, 600)) }
        else if (d instanceof Blob) { log(dir, 'blob', d.type, d.size + 'B'); d.text().then((t) => log(dir, 'blob→text', t.slice(0, 600))).catch(() => {}) }
        else if (d instanceof ArrayBuffer) { log(dir, 'binary', d.byteLength + 'B', new TextDecoder().decode(new Uint8Array(d).slice(0, 600))) }
        else if (ArrayBuffer.isView(d)) { log(dir, 'binview', d.byteLength + 'B', new TextDecoder().decode(new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice(0, 600))) }
      }
      const Wrapped = function (...a) {
        const ws = new OrigWS(...a)
        try {
          log('WebSocket OPEN →', String(a[0]))   // always log the URL (conduit sockets included)
          ws.addEventListener('message', (e) => dump('WS ←', e.data))
          // Tee OUTGOING frames too — on a WS-only transport (ChatGPT's "conduit")
          // the PROMPT leaves over send(); listening to messages alone sees only the
          // answer half, which is why a message-only logger can't crack it.
          const origSend = ws.send
          ws.send = function (data) { try { dump('WS →', data) } catch {} return origSend.call(this, data) }
        } catch {}
        return ws
      }
      Wrapped.prototype = OrigWS.prototype
      try { Object.assign(Wrapped, OrigWS) } catch {}
      window.WebSocket = Wrapped
    }
  } catch { /* leave native if anything about wrapping fails */ }
})()
