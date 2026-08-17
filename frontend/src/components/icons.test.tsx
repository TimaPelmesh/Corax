import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { IconLogo } from './icons'

describe('IconLogo', () => {
  it('renders accessible title when provided', () => {
    render(<IconLogo title="Логотип" />)
    expect(screen.getByTitle('Логотип')).toBeInTheDocument()
  })
})
