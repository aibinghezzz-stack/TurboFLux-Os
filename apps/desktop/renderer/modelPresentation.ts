// 模型服务商标识：使用通用字母徽章，不包含任何第三方品牌图形资产。
const marks: Record<string, string> = {
  openai: '<svg viewBox="0 0 24 24" role="img" aria-label="OpenAI"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.6"/><text x="12" y="16.5" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor" font-family="-apple-system, BlinkMacSystemFont, sans-serif">O</text></svg>',
  deepseek: '<svg viewBox="0 0 24 24" role="img" aria-label="DeepSeek"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.6"/><text x="12" y="16.5" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor" font-family="-apple-system, BlinkMacSystemFont, sans-serif">DS</text></svg>',
  kimi: '<svg viewBox="0 0 24 24" role="img" aria-label="Kimi"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.6"/><text x="12" y="16.5" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor" font-family="-apple-system, BlinkMacSystemFont, sans-serif">K</text></svg>',
  anthropic: '<svg viewBox="0 0 24 24" role="img" aria-label="Anthropic"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.6"/><text x="12" y="16.5" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor" font-family="-apple-system, BlinkMacSystemFont, sans-serif">A</text></svg>',
  openrouter: '<svg viewBox="0 0 24 24" role="img" aria-label="OpenRouter"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.6"/><text x="12" y="16.5" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor" font-family="-apple-system, BlinkMacSystemFont, sans-serif">OR</text></svg>',
  zhipu: '<svg viewBox="0 0 24 24" role="img" aria-label="GLM"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.6"/><text x="12" y="16.5" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor" font-family="-apple-system, BlinkMacSystemFont, sans-serif">G</text></svg>',
}

export function normalizedModelProvider(provider: string, modelId = ''): string {
  const value = `${provider} ${modelId}`.toLowerCase()
  if (value.includes('deepseek')) return 'deepseek'
  if (value.includes('openai') || value.includes('gpt')) return 'openai'
  if (value.includes('kimi') || value.includes('moonshot')) return 'kimi'
  if (value.includes('anthropic') || value.includes('claude')) return 'anthropic'
  if (value.includes('openrouter')) return 'openrouter'
  if (value.includes('glm') || value.includes('zhipu')) return 'zhipu'
  return 'generic'
}

export function modelProviderMark(provider: string, modelId = ''): string {
  const normalized = normalizedModelProvider(provider, modelId)
  return marks[normalized] || '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 20 8v8l-8 4.5L4 16V8Zm0 0v17M4 8l8 4.5L20 8" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.5"/></svg>'
}

export function formatCreditMultiplier(value: number | undefined): string {
  if (!Number.isFinite(value)) return ''
  return `${Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}×`
}
