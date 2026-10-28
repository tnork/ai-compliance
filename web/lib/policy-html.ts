// Server-only: sanitize user-edited policy HTML before it is stored/rendered.
// The policy document is a rich-text surface (contenteditable), so edited HTML
// is untrusted. We allow only the document's own structural tags + class hooks
// and strip everything else (scripts, styles, event handlers, iframes, etc).
// Import ONLY from server code (actions) - never a client component.
import sanitizeHtml from 'sanitize-html'

export function sanitizePolicyHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'h1', 'h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li',
      'strong', 'b', 'em', 'i', 'u', 'br', 'span', 'div', 'hr', 'blockquote',
    ],
    allowedAttributes: { '*': ['class'] }, // class carries doc-sub / doc-draft / badge styling; no other attrs
    disallowedTagsMode: 'discard',
    // no allowedSchemes needed - links aren't permitted in the document
  }).trim()
}
