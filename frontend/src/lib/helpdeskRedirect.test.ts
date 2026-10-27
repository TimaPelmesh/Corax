import { describe, expect, it } from 'vitest'
import { legacySelfServiceLocation } from './helpdeskRedirect'

describe('legacySelfServiceLocation', () => {
  it('sends /r to /h and keeps #pc=', () => {
    expect(legacySelfServiceLocation('#pc=PC-023')).toEqual({
      pathname: '/h',
      hash: '#pc=PC-023',
    })
  })

  it('accepts an empty hash', () => {
    expect(legacySelfServiceLocation('')).toEqual({ pathname: '/h', hash: '' })
  })
})
