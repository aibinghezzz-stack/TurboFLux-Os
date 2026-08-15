import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('workbench task panel product boundary', () => {
  const source = readFileSync(new URL('./workbenchPanels.ts', import.meta.url), 'utf8')
  const workbenchSource = readFileSync(new URL('./workbench.ts', import.meta.url), 'utf8')

  it('does not expose internal execution logs in the product panel', () => {
    expect(source).not.toContain('活动证据')
    expect(source).not.toContain('条证据')
    expect(source).not.toContain('renderWorkActivityRow')
    expect(source).not.toContain('activity.path')
    expect(source).not.toContain('activity.attempt')
  })

  it('keeps only semantic steps, user action, and result sections', () => {
    expect(source).toContain("section('步骤')")
    expect(source).toContain("'需要你处理'")
    expect(source).toContain("'结果'")
  })

  it('shows semantic order, dependencies, parallel work, and historical runs', () => {
    expect(source).toContain('orderedWorkSteps(run, step.childIds)')
    expect(source).toContain("dependencyDetail.className = 'work-step-dependencies'")
    expect(source).toContain("parallel ? '并行' : ''")
    expect(source).toContain("navigation.className = 'work-run-history'")
    expect(source).toContain('isCurrentRun &&')
  })

  it('does not repeat the full request in the work overview', () => {
    expect(workbenchSource).not.toContain("currentStep?.title || workRun.objective")
    expect(workbenchSource).toContain('const work = presentWorkRun(workRun)')
    expect(workbenchSource).toContain("stage.querySelector('strong')!.textContent = work.title")
  })

  it('prefers semantic work stages and keeps tool categories as fallback details', () => {
    expect(workbenchSource).not.toContain('function createExecutionGroup(')
    expect(workbenchSource).not.toContain('function updateExecutionGroup(')
    expect(workbenchSource).toContain('createLinearTaskFlowRenderer(transcript, {')
    expect(workbenchSource).toContain('renderCanonicalTaskFlow(true)')
    expect(workbenchSource).toContain('applyTaskFlowEvent(taskFlowProjection, event.event)')
  })
})
