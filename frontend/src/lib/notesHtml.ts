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

export type NoteFormat = 'bold' | 'italic' | 'ul' | 'h2' | 'p'

function ancestorTag(node: Node | null, root: HTMLElement, tags: string[]): HTMLElement | null {
  let current: Node | null = node
  while (current && current !== root) {
    if (current instanceof HTMLElement && tags.includes(current.tagName)) return current
    current = current.parentNode
  }
  return null
}

function unwrap(el: HTMLElement) {
  const parent = el.parentNode
  if (!parent) return
  while (el.firstChild) parent.insertBefore(el.firstChild, el)
  el.remove()
}

/** Format the current selection inside the note. Does not use execCommand. */
export function formatNoteSelection(root: HTMLElement, kind: NoteFormat): boolean {
  root.focus()
  const selection = root.ownerDocument.getSelection()
  if (!selection || selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return false
  const doc = root.ownerDocument

  if (kind === 'bold' || kind === 'italic') {
    const tag = kind === 'bold' ? 'STRONG' : 'EM'
    const name = kind === 'bold' ? 'strong' : 'em'
    const existing = ancestorTag(range.commonAncestorContainer, root, [tag, kind === 'bold' ? 'B' : 'I'])
    if (existing) {
      unwrap(existing)
      return true
    }
    const wrap = doc.createElement(name)
    if (range.collapsed) {
      wrap.textContent = '\u200b'
      range.insertNode(wrap)
      return true
    }
    try {
      range.surroundContents(wrap)
    } catch {
      wrap.appendChild(range.extractContents())
      range.insertNode(wrap)
    }
    return true
  }

  if (kind === 'ul') {
    const list = ancestorTag(range.commonAncestorContainer, root, ['UL'])
    if (list) {
      const fragment = doc.createDocumentFragment()
      for (const item of [...list.querySelectorAll(':scope > li')]) {
        const paragraph = doc.createElement('p')
        while (item.firstChild) paragraph.appendChild(item.firstChild)
        if (!paragraph.childNodes.length) paragraph.appendChild(doc.createElement('br'))
        fragment.appendChild(paragraph)
      }
      list.replaceWith(fragment)
      return true
    }
    const ul = doc.createElement('ul')
    const li = doc.createElement('li')
    if (range.collapsed) li.appendChild(doc.createElement('br'))
    else li.appendChild(range.extractContents())
    ul.appendChild(li)
    range.insertNode(ul)
    return true
  }

  const wanted = kind === 'h2' ? 'h2' : 'p'
  const block = ancestorTag(range.commonAncestorContainer, root, ['H2', 'P', 'DIV', 'LI'])
  if (block && block !== root && block.tagName !== 'LI') {
    if (block.tagName === wanted.toUpperCase()) return true
    const next = doc.createElement(wanted)
    while (block.firstChild) next.appendChild(block.firstChild)
    block.replaceWith(next)
    return true
  }
  const created = doc.createElement(wanted)
  if (range.collapsed) created.appendChild(doc.createElement('br'))
  else created.appendChild(range.extractContents())
  range.insertNode(created)
  return true
}
