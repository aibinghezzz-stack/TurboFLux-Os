import { describe, expect, it } from 'vitest'
import { formatCreditMultiplier, modelProviderMark, normalizedModelProvider } from './modelPresentation'

describe('model presentation', () => {
  it('recognizes managed model providers even when the runtime provider is custom', () => {
    expect(normalizedModelProvider('custom', 'deepseek-v4-flash')).toBe('deepseek')
    expect(normalizedModelProvider('custom', 'gpt-5.6-sol')).toBe('openai')
  })

  it('renders real provider marks and concise credit multipliers', () => {
    expect(modelProviderMark('deepseek')).toContain('aria-label="DeepSeek"')
    expect(modelProviderMark('openai')).toContain('aria-label="OpenAI"')
    expect(formatCreditMultiplier(0.5)).toBe('0.5×')
    expect(formatCreditMultiplier(2.5)).toBe('2.5×')
  })
})
