import type { NativeReasoningConfig, ReasoningEffort } from '@turboflux/agent-core/contracts'
import type { WorkbenchModelOption } from '@turboflux/agent-core/workbench'

export type ReasoningTone = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export function reasoningEffortLabel(effort: ReasoningEffort): string {
  return ({
    none: '关闭',
    minimal: '极简',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '增强',
    max: '最高',
  } as const)[effort]
}

export function reasoningEffortDetail(effort: ReasoningEffort): string {
  return ({
    none: '不附加额外推理',
    minimal: '仅做必要判断',
    low: '优先响应速度',
    medium: '速度与质量平衡',
    high: '深入处理复杂问题',
    xhigh: '扩展多阶段推理',
    max: '使用模型最高推理强度',
  } as const)[effort]
}

export function reasoningTone(config?: NativeReasoningConfig): ReasoningTone {
  if (!config || config.enabled === false || config.effort === 'none') return 'none'
  if (config.effort) return config.effort
  if (config.budgetTokens) {
    if (config.budgetTokens >= 65_536) return 'max'
    if (config.budgetTokens >= 32_768) return 'max'
    if (config.budgetTokens >= 16_384) return 'xhigh'
    if (config.budgetTokens >= 8_192) return 'high'
    return 'medium'
  }
  return 'medium'
}

export interface ReasoningOption {
  id: string
  label: string
  detail: string
  config: NativeReasoningConfig
  tone: ReasoningTone
}

type ReasoningCapability = NonNullable<WorkbenchModelOption['reasoningCapabilities']>

export function buildReasoningOptions(capability: ReasoningCapability, current?: NativeReasoningConfig): ReasoningOption[] {
  if (capability.control === 'fixed') return []
  const options: ReasoningOption[] = []
  if (capability.control === 'budget') {
    if (capability.supportsToggle) options.push({ id: 'off', label: '关闭', detail: '不附加额外推理', config: { enabled: false }, tone: 'none' })
    const tones: ReasoningTone[] = ['low', 'medium', 'high', 'xhigh', 'max']
    const budgets = [4_096, 8_192, 16_384, 32_768, 65_536]
    if (current?.budgetTokens && !budgets.includes(current.budgetTokens)) budgets.push(current.budgetTokens)
    budgets.sort((left, right) => left - right)
    budgets.forEach(budgetTokens => {
      const tone = tones[Math.min(tones.length - 1, Math.max(0, budgets.indexOf(budgetTokens)))]
      const budgetK = Math.round((budgetTokens / 1024) * 10) / 10
      options.push({ id: `budget-${budgetTokens}`, label: `${budgetK}K`, detail: '推理 token 预算', config: { enabled: true, budgetTokens }, tone })
    })
    return options
  }
  if (capability.efforts.length > 0) {
    for (const effort of capability.efforts) {
      const config: NativeReasoningConfig = { enabled: effort !== 'none', effort }
      options.push({ id: `effort-${effort}`, label: reasoningEffortLabel(effort), detail: reasoningEffortDetail(effort), config, tone: reasoningTone(config) })
    }
    if (capability.supportsToggle && !capability.efforts.includes('none')) {
      options.unshift({ id: 'off', label: '关闭', detail: '不附加额外推理', config: { enabled: false }, tone: 'none' })
    }
    return options
  }
  if (capability.supportsToggle) {
    options.push(
      { id: 'off', label: '关闭', detail: '不附加额外推理', config: { enabled: false }, tone: 'none' },
      { id: 'on', label: '开启', detail: '使用模型原生推理', config: { enabled: true }, tone: 'medium' },
    )
  }
  return options
}

export function effectiveReasoningConfig(
  profileConfig: NativeReasoningConfig | undefined,
  modelConfig: NativeReasoningConfig | undefined,
  capability: ReasoningCapability,
): NativeReasoningConfig {
  if (profileConfig) return { ...profileConfig }
  if (modelConfig) return { ...modelConfig }
  return {
    enabled: capability.supportsToggle ? capability.defaultEnabled !== false : true,
    effort: capability.defaultEffort,
    budgetTokens: capability.control === 'budget' ? capability.defaultBudgetTokens : undefined,
  }
}

export function reasoningOptionIndex(options: ReasoningOption[], current: NativeReasoningConfig): number {
  const disabled = current.enabled === false || current.effort === 'none'
  const index = options.findIndex(option => {
    if (option.config.enabled === false || option.config.effort === 'none') return disabled
    if (disabled) return false
    if (option.config.budgetTokens !== undefined) return current.budgetTokens === option.config.budgetTokens
    if (option.config.effort !== undefined) return current.effort === option.config.effort
    return current.enabled !== false
  })
  return index >= 0 ? index : 0
}
