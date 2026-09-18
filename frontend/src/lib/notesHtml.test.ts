import { describe, expect, it } from 'vitest'
import { noteBodyLooksEmpty, sanitizeNoteHtml } from './notesHtml'

describe('sanitizeNoteHtml', () => {
  it('keeps ordinary description text', () => {
    expect(sanitizeNoteHtml('<p>Купить тонер</p>')).toContain('Купить тонер')
    expect(sanitizeNoteHtml('<div>строка 1</div><div>строка 2</div>')).toContain('строка 1')
  })

  it('drops scripts but keeps surrounding text', () => {
    const out = sanitizeNoteHtml('<p>ok</p><script>alert(1)</script><p>still</p>')
    expect(out).toContain('ok')
    expect(out).toContain('still')
    expect(out.toLowerCase()).not.toContain('script')
  })
})

describe('noteBodyLooksEmpty', () => {
  it('treats blank editor chrome as empty', () => {
    expect(noteBodyLooksEmpty('<p><br></p>')).toBe(true)
    expect(noteBodyLooksEmpty('<div><br></div>')).toBe(true)
    expect(noteBodyLooksEmpty('<p>есть текст</p>')).toBe(false)
  })
})
