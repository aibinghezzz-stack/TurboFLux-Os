export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'turboflux.appearance.theme'

const themeColors: Record<ResolvedTheme, string> = {
  light: '#f5f5f3',
  dark: '#151715',
}

export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system'
}

export function resolveThemePreference(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference
}

export function currentThemePreference(): ThemePreference {
  const datasetPreference = document.documentElement.dataset.themePreference
  if (datasetPreference) return normalizeThemePreference(datasetPreference)
  try {
    return normalizeThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    return 'system'
  }
}

function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveThemePreference(preference, window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.themePreference = preference
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', themeColors[resolved])
  window.dispatchEvent(new CustomEvent('turboflux:theme-change', { detail: { preference, resolved } }))
  return resolved
}

export function setThemePreference(preference: ThemePreference): ResolvedTheme {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference)
  } catch {}
  return applyTheme(preference)
}

export function initializeTheme(): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  applyTheme(currentThemePreference())
  const handleSystemTheme = () => {
    if (currentThemePreference() === 'system') applyTheme('system')
  }
  const handleStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY) applyTheme(normalizeThemePreference(event.newValue))
  }
  media.addEventListener('change', handleSystemTheme)
  window.addEventListener('storage', handleStorage)
  return () => {
    media.removeEventListener('change', handleSystemTheme)
    window.removeEventListener('storage', handleStorage)
  }
}
