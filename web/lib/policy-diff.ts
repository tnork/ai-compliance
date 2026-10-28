// Server-side "what changed" view between two policy versions (0031: who
// changed what & when). Input HTML comes from policy_version.body_html, which
// is sanitized on save AND re-sanitized on render - but this module still
// treats it as untrusted: it reduces both documents to plain text and builds
// the output exclusively from escaped text inside our own <ins>/<del>/<div>
// tags, so nothing from the stored HTML can reach the page as markup.
//
// Approach (right-sized for ~2-page policy docs, no dependency): block-level
// LCS over text lines, then a word-level LCS inside changed line pairs.

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// HTML → text lines at block boundaries.
function toLines(html: string): string[] {
  const text = html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:h1|h2|h3|h4|p|li|ul|ol|div|blockquote|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘')
    .replace(/&rdquo;/g, '”').replace(/&ldquo;/g, '“')
  return text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

type Op<T> = { type: 'same' | 'del' | 'ins'; value: T }

// Classic LCS diff; inputs here are policy-sized (hundreds of lines / dozens
// of words per line), so the O(n*m) table is comfortably small.
function lcsDiff<T>(a: T[], b: T[]): Op<T>[] {
  const n = a.length, m = b.length
  const table = new Uint32Array((n + 1) * (m + 1))
  const at = (i: number, j: number) => table[i * (m + 1) + j]
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i * (m + 1) + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
  const ops: Op<T>[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ type: 'same', value: a[i] }); i++; j++ }
    else if (at(i + 1, j) >= at(i, j + 1)) { ops.push({ type: 'del', value: a[i] }); i++ }
    else { ops.push({ type: 'ins', value: b[j] }); j++ }
  }
  while (i < n) ops.push({ type: 'del', value: a[i++] })
  while (j < m) ops.push({ type: 'ins', value: b[j++] })
  return ops
}

function wordDiffHtml(oldLine: string, newLine: string): string {
  const parts = lcsDiff(oldLine.split(/\s+/), newLine.split(/\s+/)).map((op) =>
    op.type === 'same' ? esc(op.value)
      : op.type === 'del' ? `<del>${esc(op.value)}</del>`
        : `<ins>${esc(op.value)}</ins>`)
  return parts.join(' ')
}

// Returns safe HTML (escaped text in our own tags) describing the change from
// prevHtml to curHtml, or null when the text content is identical.
export function diffPolicyHtml(prevHtml: string, curHtml: string): string | null {
  const ops = lcsDiff(toLines(prevHtml), toLines(curHtml))
  if (!ops.some((o) => o.type !== 'same')) return null

  const out: string[] = []
  let k = 0
  while (k < ops.length) {
    const op = ops[k]
    if (op.type === 'same') { out.push(`<div class="diff-line">${esc(op.value)}</div>`); k++; continue }
    // collect the contiguous changed run, then pair deletions with insertions
    // so a reworded line renders as ONE line with word-level ins/del marks
    const dels: string[] = [], inss: string[] = []
    while (k < ops.length && ops[k].type !== 'same') {
      if (ops[k].type === 'del') dels.push(ops[k].value); else inss.push(ops[k].value)
      k++
    }
    const paired = Math.min(dels.length, inss.length)
    for (let p = 0; p < paired; p++)
      out.push(`<div class="diff-line diff-changed">${wordDiffHtml(dels[p], inss[p])}</div>`)
    for (let p = paired; p < dels.length; p++)
      out.push(`<div class="diff-line diff-removed"><del>${esc(dels[p])}</del></div>`)
    for (let p = paired; p < inss.length; p++)
      out.push(`<div class="diff-line diff-added"><ins>${esc(inss[p])}</ins></div>`)
  }
  return out.join('')
}
