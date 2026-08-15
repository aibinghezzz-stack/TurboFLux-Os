import { describe, expect, it } from 'vitest'
import { normalizeThemePreference, resolveThemePreference } from './theme'

describe('desktop theme preference', () => {
  it('normalizes persisted values without accepting unknown themes', () => {
    expect(normalizeThemePreference('light')).toBe('light')
    expect(normalizeThemePreference('dark')).toBe('dark')
    expect(normalizeThemePreference('system')).toBe('system')
    expect(normalizeThemePreference('midnight')).toBe('system')
  })

  it('resolves the system preference while preserving explicit choices', () => {
    expect(resolveThemePreference('system', true)).toBe('dark')
    expect(resolveThemePreference('system', false)).toBe('light')
    expect(resolveThemePreference('light', true)).toBe('light')
    expect(resolveThemePreference('dark', false)).toBe('dark')
  })
})
