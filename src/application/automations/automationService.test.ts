import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutomationService, nextAutomationRunAt } from './automationService'

const directories: string[] = []
afterEach(() => { vi.useRealTimers(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('AutomationService', () => {
  it('computes interval runs, marks due work, and survives restart', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-07T09:00:00+08:00'))
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const store = join(root, 'automations.json')
    const workspace = join(root, 'workspace')
    const service = new AutomationService(store)
    const created = service.create({ name: 'Review', prompt: 'Review outputs', workspacePath: workspace, schedule: { kind: 'interval', everyMinutes: 30 } }).automations[0]
    expect(created.nextRunAt).toBe(Date.now() + 30 * 60_000)
    expect(service.due(workspace, created.nextRunAt! - 1)).toEqual([])
    expect(service.due(workspace, created.nextRunAt!)).toHaveLength(1)
    service.markRun(created.id, 'completed', { now: created.nextRunAt })
    expect(new AutomationService(store).list(workspace).automations[0]).toMatchObject({ lastStatus: 'completed', nextRunAt: created.nextRunAt! + 30 * 60_000 })
  })

  it('removes next run while disabled and restores it when enabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const automation = service.create({ name: 'Daily', prompt: 'Run daily', workspacePath: root, schedule: { kind: 'daily', time: '09:30' } }).automations[0]
    expect(service.update(automation.id, { enabled: false }).automations[0].nextRunAt).toBeUndefined()
    expect(service.update(automation.id, { enabled: true }).automations[0].nextRunAt).toBeTypeOf('number')
  })

  it('supports one-time and weekly schedules', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-07T09:00:00+08:00'))
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const onceAt = new Date('2026-08-07T10:30:00+08:00').toISOString()
    const once = service.create({ name: 'Once', prompt: 'Run once', workspacePath: root, schedule: { kind: 'once', at: onceAt } }).automations[0]
    expect(once.nextRunAt).toBe(Date.parse(onceAt))
    expect(service.claimDue(root, { now: Date.parse(onceAt) })).toHaveLength(1)
    expect(service.get(once.id)).toMatchObject({ enabled: false, nextRunAt: undefined })

    const weekly = service.create({ name: 'Weekly', prompt: 'Run weekly', workspacePath: root, schedule: { kind: 'weekly', weekday: 1, time: '09:30' }, timezone: 'Asia/Shanghai' }).automations[0]
    expect(new Date(weekly.nextRunAt!).toISOString()).toBe(new Date('2026-08-10T09:30:00+08:00').toISOString())
  })

  it('keeps bounded run history and advances a schedule only once per run', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-07T09:00:00+08:00'))
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const automation = service.create({
      name: 'Review',
      prompt: 'Review outputs',
      workspacePath: root,
      schedule: { kind: 'interval', everyMinutes: 30 },
      approvalPolicy: 'agent',
    }).automations[0]
    const claim = service.claimDue(root, { now: automation.nextRunAt })[0]!
    const advancedAt = service.get(automation.id)!.nextRunAt
    service.markRunStatus(automation.id, claim.run.id, 'running', { inputId: 'input-1', now: automation.nextRunAt! + 1_000 })
    service.markRunStatus(automation.id, claim.run.id, 'completed', { inputId: 'input-1', now: automation.nextRunAt! + 2_000 })
    expect(service.get(automation.id)).toMatchObject({ approvalPolicy: 'agent', nextRunAt: advancedAt })
    expect(service.get(automation.id)!.history).toEqual([
      expect.objectContaining({ inputId: 'input-1', status: 'completed', completedAt: expect.any(Number) }),
    ])
  })

  it('duplicates automations as disabled independent records', () => {
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const original = service.create({ name: 'Daily', prompt: 'Run daily', workspacePath: root, schedule: { kind: 'daily', time: '09:30' }, approvalPolicy: 'full' }).automations[0]
    const copy = service.duplicate(original.id).automations.find(item => item.id !== original.id)!
    expect(copy).toMatchObject({ name: 'Daily 副本', enabled: false, approvalPolicy: 'full', history: [] })
  })

  it('marks overdue work in another project as waiting without consuming its schedule', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-07T09:00:00+08:00'))
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const otherWorkspace = join(root, 'other')
    const automation = service.create({ name: 'Other', prompt: 'Run elsewhere', workspacePath: otherWorkspace, schedule: { kind: 'interval', everyMinutes: 30 } }).automations[0]
    expect(service.markInactiveDueWaiting(root, automation.nextRunAt)).toBe(true)
    expect(service.get(automation.id)).toMatchObject({ lastStatus: 'waiting_for_workspace', nextRunAt: automation.nextRunAt })
    expect(service.markInactiveDueWaiting(root, automation.nextRunAt! + 1_000)).toBe(false)
    expect(service.due(otherWorkspace, automation.nextRunAt)).toHaveLength(1)
  })

  it('resolves daily schedules across daylight-saving transitions', () => {
    const spring = nextAutomationRunAt(
      { kind: 'daily', time: '02:30' },
      'America/New_York',
      Date.parse('2026-03-08T01:59:00-05:00'),
    )
    expect(new Date(spring!).toISOString()).toBe('2026-03-09T06:30:00.000Z')

    const firstFall = nextAutomationRunAt(
      { kind: 'daily', time: '01:30' },
      'America/New_York',
      Date.parse('2026-11-01T00:59:00-04:00'),
    )
    expect(new Date(firstFall!).toISOString()).toBe('2026-11-01T05:30:00.000Z')
    const secondFall = nextAutomationRunAt(
      { kind: 'daily', time: '01:30' },
      'America/New_York',
      firstFall! + 60_000,
    )
    expect(new Date(secondFall!).toISOString()).toBe('2026-11-01T06:30:00.000Z')
  })

  it('applies misfire and overlap policies without duplicate claims', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-07T09:00:00+08:00'))
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const skipped = service.create({
      name: 'Skip stale',
      prompt: 'Check once',
      workspacePath: root,
      schedule: { kind: 'interval', everyMinutes: 1 },
      misfirePolicy: 'skip',
    }).automations[0]
    expect(service.claimDue(root, { now: skipped.nextRunAt! + 61_000 })).toEqual([])
    expect(service.get(skipped.id)?.history[0]).toMatchObject({ status: 'skipped', trigger: 'scheduled' })
    service.update(skipped.id, { enabled: false })

    const queued = service.create({
      name: 'Queue overlap',
      prompt: 'Keep one occurrence',
      workspacePath: root,
      schedule: { kind: 'interval', everyMinutes: 1 },
      overlapPolicy: 'queue-one',
    }).automations[0]
    const claim = service.claimDue(root, { now: queued.nextRunAt! }).find(item => item.automation.id === queued.id)!
    expect(service.claimDue(root, { now: queued.nextRunAt! })).toEqual([])
    const completionAt = service.get(queued.id)!.nextRunAt! + 60_000
    service.markRunStatus(queued.id, claim.run.id, 'completed', { now: completionAt })
    const after = service.get(queued.id)!
    expect(after.pendingRunAt).toBeTypeOf('number')
    expect(service.claimDue(root, { now: completionAt })).toEqual([
      expect.objectContaining({ automation: expect.objectContaining({ id: queued.id }) }),
    ])
  })

  it('retries with exponential backoff and supports explicit cancellation', () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-08-07T01:00:00.000Z')
    vi.setSystemTime(now)
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const service = new AutomationService(join(root, 'automations.json'))
    const automation = service.create({
      name: 'Retry work',
      prompt: 'Try reliably',
      workspacePath: root,
      schedule: { kind: 'manual' },
      retryPolicy: { maxRetries: 2, backoffMinutes: 2 },
    }).automations[0]
    const first = service.claimManual(automation.id, now)
    service.markRunStatus(automation.id, first.run.id, 'failed', { now: now + 1_000, error: 'Temporary failure' })
    const failed = service.getRun(automation.id, first.run.id)!
    expect(failed).toMatchObject({ status: 'retry_scheduled', retryAt: now + 121_000 })
    const retry = service.claimDue(root, { now: failed.retryAt })[0]!
    expect(retry.run).toMatchObject({ trigger: 'retry', attempt: 2 })
    expect(service.cancelActiveRun(automation.id, now + 122_000)).toMatchObject({ status: 'canceled' })
    expect(service.get(automation.id)).toMatchObject({ activeRunId: undefined, lastStatus: 'canceled' })
  })

  it('migrates v1 data and recovers interrupted runs on startup', () => {
    vi.useFakeTimers()
    const now = Date.parse('2026-08-07T01:00:00.000Z')
    vi.setSystemTime(now)
    const root = mkdtempSync(join(tmpdir(), 'turboflux-automation-'))
    directories.push(root)
    const store = join(root, 'automations.json')
    writeFileSync(store, JSON.stringify({
      schemaVersion: 1,
      automations: [{
        id: 'legacy',
        name: 'Legacy',
        prompt: 'Resume safely',
        workspacePath: root,
        schedule: { kind: 'manual' },
        enabled: true,
        approvalPolicy: 'ask',
        createdAt: now - 10_000,
        updatedAt: now - 5_000,
        activeRunId: 'legacy-run',
        history: [{
          id: 'legacy-run',
          trigger: 'scheduled',
          status: 'running',
          attempt: 1,
          startedAt: now - 5_000,
          updatedAt: now - 5_000,
        }],
      }],
    }))
    const migrated = new AutomationService(store).get('legacy')!
    expect(migrated).toMatchObject({
      timezone: expect.any(String),
      misfirePolicy: 'run-once',
      overlapPolicy: 'skip',
      retryPolicy: { maxRetries: 2, backoffMinutes: 2 },
      activeRunId: undefined,
      lastStatus: 'retry_scheduled',
    })
    expect(migrated.history[0]).toMatchObject({ status: 'retry_scheduled', error: expect.stringContaining('exited') })
  })
})
