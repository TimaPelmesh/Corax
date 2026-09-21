/** Strip executable markup from a note body. Keep ordinary text and basic tags. */

const BANNED = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'FORM', 'INPUT', 'BUTTON', 'SVG', 'STYLE'])

function isBoldStyle(style: string): boolean {
  return /font-weight\s*:\s*(bold|[6-9]00|bolder)/i.test(style)
}

function isItalicStyle(style: string): boolean {
  return /font-style\s*:\s*italic/i.test(style)
}

function wrapContents(el: HTMLElement, tag: string) {
  const wrap = el.ownerDocument.createElement(tag)
  while (el.firstChild) wrap.appendChild(el.firstChild)
  el.appendChild(wrap)
}

/** Chrome execCommand often wraps Ж/К in span[style=...] which the sanitizer used to drop. */
function promoteInlineStyles(el: HTMLElement) {
  const style = el.getAttribute('style') || ''
  if (el.tagName === 'SPAN' || el.tagName === 'FONT') {
    if (isBoldStyle(style)) wrapContents(el, 'strong')
    if (isItalicStyle(style)) wrapContents(el, 'em')
  }
}

export function sanitizeNoteHtml(html: string): string {
  if (!html) return ''
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const walk = (node: ParentNode) => {
    ;[...node.childNodes].forEach((child) => {
      if (child.nodeType === Node.COMMENT_NODE) {
        const text = (child as Comment).data
        if (text.trim()) {
          child.parentNode?.replaceChild(doc.createTextNode(text), child)
        } else {
          child.parentNode?.removeChild(child)
        }
        return
      }
      if (child.nodeType !== Node.ELEMENT_NODE) return
      const el = child as HTMLElement
      if (BANNED.has(el.tagName)) {
        el.remove()
        return
      }
      promoteInlineStyles(el)
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase()
        if (name.startsWith('on') || name === 'style' || name === 'src' || name === 'srcset') {
          el.removeAttribute(attr.name)
        }
      }
      if (el.tagName === 'A') {
        const href = (el.getAttribute('href') || '').trim()
        if (href && !/^(https?:|mailto:|\/|#)/i.test(href)) el.removeAttribute('href')
      }
      walk(el)
    })
  }
  walk(doc.body)
  return doc.body.innerHTML
}

export function noteBodyLooksEmpty(html: string): boolean {
  const text = html.replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/\u200b/g, '').trim()
  return text.length === 0
}

export function readNoteEditorHtml(noteId: number): string | null {
  const el = document.querySelector(`.notes-editor[data-note-id="${noteId}"]`)
  if (!(el instanceof HTMLElement)) return null
  return el.innerHTML
}
