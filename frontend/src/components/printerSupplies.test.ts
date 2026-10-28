import { describe, expect, it } from 'vitest'
import {
  hasLowToner,
  isTonerSupply,
  partitionSupplies,
  printerStatusChip,
  tonerShort,
} from './printerSupplies'

describe('isTonerSupply', () => {
  it('accepts toner and cartridges', () => {
    expect(isTonerSupply('Black Toner')).toBe(true)
    expect(isTonerSupply('Cyan Cartridge CE401A')).toBe(true)
    expect(isTonerSupply('Ribbon')).toBe(true)
  })

  it('rejects drums, fusers, waste', () => {
    expect(isTonerSupply('Imaging Unit')).toBe(false)
    expect(isTonerSupply('Fuser Kit')).toBe(false)
    expect(isTonerSupply('Waste Toner')).toBe(false)
  })
})

describe('partitionSupplies', () => {
  it('splits and orders CMYK toners', () => {
    const { toners, service } = partitionSupplies([
      { name: 'Yellow Toner', level_percent: 40, level_raw: 40, max_capacity: 100 },
      { name: 'Drum Unit', level_percent: 80, level_raw: 80, max_capacity: 100 },
      { name: 'Black Toner', level_percent: 10, level_raw: 10, max_capacity: 100 },
      { name: 'Cyan Toner', level_percent: 55, level_raw: 55, max_capacity: 100 },
    ])
    expect(toners.map((s) => s.name)).toEqual(['Black Toner', 'Cyan Toner', 'Yellow Toner'])
    expect(service.map((s) => s.name)).toEqual(['Drum Unit'])
  })
})

describe('hasLowToner', () => {
  it('flags toner at or below threshold', () => {
    expect(
      hasLowToner([
        { name: 'Black Toner', level_percent: 15, level_raw: 15, max_capacity: 100 },
        { name: 'Drum', level_percent: 5, level_raw: 5, max_capacity: 100 },
      ]),
    ).toBe(true)
    expect(
      hasLowToner([{ name: 'Black Toner', level_percent: 40, level_raw: 40, max_capacity: 100 }]),
    ).toBe(false)
  })
})

describe('tonerShort', () => {
  it('maps CMYK nicknames', () => {
    expect(tonerShort('Black Cartridge')).toBe('K')
    expect(tonerShort('Cyan')).toBe('C')
    expect(tonerShort('Magenta')).toBe('M')
    expect(tonerShort('Yellow')).toBe('Y')
  })
})

describe('printerStatusChip', () => {
  it('returns token-based classes for each tone', () => {
    expect(printerStatusChip('online')).toContain('--color-success')
    expect(printerStatusChip('offline')).toContain('--color-warning')
    expect(printerStatusChip('error')).toContain('--color-error')
    expect(printerStatusChip('unknown')).toContain('--color-fg-muted')
  })
})
