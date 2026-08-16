import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { normalizeThemePreference, resolveThemePreference } from './theme'

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

function darkRule(selector: string): string {
  const start = styles.indexOf(`html[data-theme="dark"] ${selector}`)
  expect(start, `missing dark theme rule for ${selector}`).toBeGreaterThanOrEqual(0)
  return styles.slice(start, styles.indexOf('}', start) + 1)
}

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

  it('themes every major raised surface used by the desktop workbench', () => {
    expect(darkRule('.tool-activity {')).toContain('background: #191c19')
    expect(darkRule('.visual-evidence-thumbnail {')).toContain('background: #1b1e1b')
    expect(darkRule('.artifact-preview pre {')).toContain('background: #151815')
    expect(darkRule('.model-only-menu,')).toContain('background: rgba(27,30,27,.97)')
    expect(darkRule('.subagent-detail {')).toContain('background: rgba(27,30,27,.92)')
    expect(darkRule('.usage-debt-note {')).toContain('background: #2a201e')
  })

  it('defines dark semantic aliases used by Work panels', () => {
    const rootRule = darkRule('{')
    expect(rootRule).toContain('--muted-strong: #c9cdc5')
    expect(rootRule).toContain('--ink: #f2f3ee')
  })
})
