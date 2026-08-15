import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('workbench task panel product boundary', () => {
  const source = readFileSync(new URL('./workbenchPanels.ts', import.meta.url), 'utf8')
  const workbenchSource = readFileSync(new URL('./workbench.ts', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

  it('does not expose internal execution logs in the product panel', () => {
    expect(source).not.toContain('活动证据')
    expect(source).not.toContain('条证据')
    expect(source).not.toContain('renderWorkActivityRow')
    expect(source).not.toContain('activity.path')
    expect(source).not.toContain('activity.attempt')
  })

  it('keeps only semantic steps, user action, and result sections', () => {
    expect(source).toContain("section('步骤')")
    expect(source).toContain("section('终端进程'")
    expect(source).toContain("'需要你处理'")
    expect(source).toContain("'结果'")
  })

  it('keeps task surfaces independent from the work drawer', () => {
    expect(workbenchSource).toContain('id="task-companion"')
    expect(workbenchSource).toContain('id="work-plan-dock"')
    expect(workbenchSource).toContain('id="inspector-toggle" title="打开工作侧栏">${icon(\'panel\')}</button>')
    expect(workbenchSource.indexOf('id="inspector-toggle"')).toBeLessThan(workbenchSource.indexOf('</main>'))
    expect(workbenchSource).toContain('id="inspector-close"')
    expect(workbenchSource).not.toContain("icon('summary')")
    expect(workbenchSource).not.toContain('task-panel-toggle')
    expect(styles).toContain('.task-companion { position: absolute;')
    expect(workbenchSource).toContain('createComputerControls(app, bridge')
    expect(workbenchSource).toContain('presentTaskCompanion({')
    expect(workbenchSource).toContain("if (item.kind === 'preview' && preview?.url) void openBrowserInInspector(preview.url)")
    expect(workbenchSource).not.toContain('inspectorDismissedConversationIds')
    expect(styles).toContain('.desktop-shell.inspector-open .main-panel { margin-right: var(--work-panel-width); }')
  })

  it('uses distinct semantic icons for every approval policy', () => {
    expect(workbenchSource).toContain("ask: icon('approvalAsk')")
    expect(workbenchSource).toContain("agent: icon('approvalAgent')")
    expect(workbenchSource).toContain("full: icon('approvalFull')")
    expect(workbenchSource).not.toContain('♢')
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
