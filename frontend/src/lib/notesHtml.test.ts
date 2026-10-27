import { describe, expect, it } from 'vitest'
import { formatNoteSelection, noteBodyLooksEmpty, sanitizeNoteHtml } from './notesHtml'

describe('sanitizeNoteHtml', () => {
  it('keeps ordinary description text', () => {
    expect(sanitizeNoteHtml('<p>Купить тонер</p>')).toContain('Купить тонер')
    expect(sanitizeNoteHtml('<div>строка 1</div><div>строка 2</div>')).toContain('строка 1')
  })

  it('keeps bold/italic from Chrome span styles used by toolbar buttons', () => {
    const out = sanitizeNoteHtml(
      '<p><span style="font-weight: 700">жирный</span> и <span style="font-style: italic">курсив</span></p>',
    )
    expect(out).toContain('жирный')
    expect(out).toContain('курсив')
    expect(out.toLowerCase()).toMatch(/<(strong|b)>/)
    expect(out.toLowerCase()).toMatch(/<(em|i)>/)
  })

  it('turns HTML comments into visible text instead of dropping the rest of the note', () => {
    const out = sanitizeNoteHtml('<p>до</p><!-- комментарий --><p>после</p>')
    expect(out).toContain('до')
    expect(out).toContain('после')
    expect(out).toContain('комментарий')
    expect(out).not.toContain('<!--')
  })

  it('drops scripts but keeps surrounding text', () => {
    const out = sanitizeNoteHtml('<p>ok</p><script>alert(1)</script><p>still</p>')
    expect(out).toContain('ok')
    expect(out).toContain('still')
    expect(out.toLowerCase()).not.toContain('script')
  })
})

describe('formatNoteSelection', () => {
  it('wraps the selected words in strong and can unwrap them', () => {
    const root = document.createElement('div')
    root.textContent = 'купить тонер'
    document.body.appendChild(root)
    const text = root.firstChild
    if (!text) throw new Error('missing text')
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 6)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    expect(formatNoteSelection(root, 'bold')).toBe(true)
    expect(root.querySelector('strong')?.textContent).toBe('купить')
    const again = document.createRange()
    const strong = root.querySelector('strong')
    if (!strong?.firstChild) throw new Error('missing strong')
    again.selectNodeContents(strong)
    selection?.removeAllRanges()
    selection?.addRange(again)
    expect(formatNoteSelection(root, 'bold')).toBe(true)
    expect(root.querySelector('strong')).toBeNull()
    expect(root.textContent).toContain('купить')
    root.remove()
  })
})

describe('noteBodyLooksEmpty', () => {
  it('treats blank editor chrome as empty', () => {
    expect(noteBodyLooksEmpty('<p><br></p>')).toBe(true)
    expect(noteBodyLooksEmpty('<div><br></div>')).toBe(true)
    expect(noteBodyLooksEmpty('<p>есть текст</p>')).toBe(false)
  })
})
