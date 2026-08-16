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
    expect(workbenchSource.match(/id="inspector-toggle"/g) ?? []).toHaveLength(1)
    expect(workbenchSource).toContain('class="icon-button work-drawer-toggle" id="inspector-toggle"')
    expect(workbenchSource.indexOf('</main>')).toBeLessThan(workbenchSource.indexOf('id="inspector-toggle"'))
    expect(workbenchSource).not.toContain('id="inspector-close"')
    expect(workbenchSource).not.toContain("icon('summary')")
    expect(workbenchSource).not.toContain('task-panel-toggle')
    expect(styles).toContain('.task-companion { position: absolute;')
    expect(workbenchSource).toContain('createComputerControls(app, bridge')
    expect(workbenchSource).toContain('presentTaskCompanion({')
    expect(workbenchSource).toContain("if (item.kind === 'preview' && preview?.url) void openBrowserInInspector(preview.url)")
    expect(workbenchSource).not.toContain('inspectorDismissedConversationIds')
    expect(styles).toContain('.desktop-shell.inspector-open .main-panel { margin-right: var(--work-panel-width); }')
  })

  it('keeps the work drawer populated with real modules and dedicated icons', () => {
    expect(workbenchSource).toContain("{ tab: 'activity', label: '任务', iconName: 'activity' }")
    expect(workbenchSource).toContain("{ tab: 'browser', label: '浏览器', iconName: 'browser' }")
    expect(workbenchSource).toContain("{ tab: 'outputs', label: '产物', iconName: 'outputs' }")
    expect(workbenchSource).toContain("{ tab: 'context', label: '上下文', iconName: 'context' }")
    expect(workbenchSource).toContain("{ tab: 'git', label: '版本', iconName: 'git' }")
    expect(workbenchSource).not.toContain("tab: 'terminal'")
    expect(workbenchSource).not.toContain('createWorkOverviewSection')
    expect(workbenchSource).not.toContain('renderWorkOverview')
    expect(workbenchSource).toContain('? { x: 0, y: 0, width: 0, height: 0 }')
    expect(workbenchSource).not.toContain('empty-orbit')
    expect(workbenchSource).not.toContain("glyph.textContent = '◎'")
    expect(workbenchSource).not.toContain("{ tab: 'overview', label: '概览'")
    expect(styles).toContain('.inspector-nav { display: flex;')
    expect(styles).toContain('.inspector-primary-tabs { display: grid;')
    expect(styles).toContain('.inspector-utility-tabs { display: flex;')
    expect(styles).not.toContain('.work-overview-')
    expect(styles).toContain('.empty-module-icon .icon')
    expect(styles).not.toContain('.empty-orbit')
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

  it('does not repeat the full request in the task panel', () => {
    expect(source).not.toContain('run.objective')
    expect(source).toContain('const presentation = presentWorkRun(run)')
    expect(source).toContain('title.textContent = presentation.statusLabel')
    expect(source).toContain('presentation.currentStep ? presentation.currentStep.title')
  })

  it('prefers semantic work stages and keeps tool categories as fallback details', () => {
    expect(workbenchSource).not.toContain('function createExecutionGroup(')
    expect(workbenchSource).not.toContain('function updateExecutionGroup(')
    expect(workbenchSource).toContain('createLinearTaskFlowRenderer(transcript, {')
    expect(workbenchSource).toContain('renderCanonicalTaskFlow(true)')
    expect(workbenchSource).toContain('applyTaskFlowEvent(taskFlowProjection, event.event)')
  })
})
