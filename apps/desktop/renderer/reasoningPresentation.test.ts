import { describe, expect, it } from 'vitest'
import type { WorkbenchModelOption } from '@turboflux/agent-core/workbench'
import {
  buildReasoningOptions,
  effectiveReasoningConfig,
  reasoningEffortLabel,
  reasoningOptionIndex,
} from './reasoningPresentation'

const deepSeekCapability = {
  family: 'deepseek',
  control: 'toggle-effort',
  efforts: ['low', 'high', 'max'],
  supportsToggle: true,
  defaultEnabled: true,
  defaultEffort: 'high',
  omitTemperature: true,
  description: 'DeepSeek reasoning',
} as NonNullable<WorkbenchModelOption['reasoningCapabilities']>

describe('desktop reasoning picker presentation', () => {
  it('uses localized effort labels', () => {
    expect(reasoningEffortLabel('none')).toBe('关闭')
    expect(reasoningEffortLabel('high')).toBe('高')
    expect(reasoningEffortLabel('max')).toBe('最高')
  })

  it('falls back to the model reasoning before capability defaults', () => {
    expect(effectiveReasoningConfig(undefined, { enabled: true, effort: 'max' }, deepSeekCapability)).toEqual({ enabled: true, effort: 'max' })
    expect(effectiveReasoningConfig(undefined, undefined, deepSeekCapability)).toEqual({ enabled: true, effort: 'high', budgetTokens: undefined })
  })

  it('selects the effective setting and treats every disabled shape as off', () => {
    const options = buildReasoningOptions(deepSeekCapability)
    expect(options.map(option => option.label)).toEqual(['关闭', '低', '高', '最高'])
    expect(reasoningOptionIndex(options, { enabled: true, effort: 'high' })).toBe(2)
    expect(reasoningOptionIndex(options, { enabled: false, effort: 'high' })).toBe(0)
  })

  it('does not expose fake controls for fixed reasoning', () => {
    expect(buildReasoningOptions({ ...deepSeekCapability, control: 'fixed', supportsToggle: false })).toEqual([])
  })

  it('keeps a custom reasoning budget selectable', () => {
    const capability = {
      ...deepSeekCapability,
      family: 'anthropic',
      control: 'budget',
      efforts: [],
      defaultBudgetTokens: 8_192,
    } as NonNullable<WorkbenchModelOption['reasoningCapabilities']>
    const options = buildReasoningOptions(capability, { enabled: true, budgetTokens: 12_288 })
    expect(options.some(option => option.config.budgetTokens === 12_288)).toBe(true)
    expect(reasoningOptionIndex(options, { enabled: true, budgetTokens: 12_288 })).toBeGreaterThan(0)
  })

})
