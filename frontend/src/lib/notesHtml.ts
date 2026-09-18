/** Strip executable markup from a note body. Keep ordinary text and basic tags. */
export function sanitizeNoteHtml(html: string): string {
  if (!html) return ''
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const banned = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'FORM', 'INPUT', 'BUTTON', 'SVG', 'STYLE'])
  const walk = (node: ParentNode) => {
    ;[...node.childNodes].forEach((child) => {
      if (child.nodeType !== Node.ELEMENT_NODE) return
      const el = child as HTMLElement
      if (banned.has(el.tagName)) {
        el.remove()
        return
      }
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
