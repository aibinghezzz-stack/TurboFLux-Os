import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import type { ComputerSystemSnapshot } from '@turboflux/agent-core/contracts'

vi.mock('electron', () => ({ BrowserWindow: class {}, screen: {} }))

import { computerOverlayApprovalOptions, computerOverlayBounds, computerOverlayPresentation } from './computerActivityOverlay'

function snapshot(update: Partial<ComputerSystemSnapshot> = {}): ComputerSystemSnapshot {
  return {
    platform: 'darwin',
    available: true,
    paused: false,
    handoffActive: false,
    sessionActive: true,
    permissions: {
      screenRecording: { kind: 'screen-recording', state: 'granted', canRequest: false },
      accessibility: { kind: 'accessibility', state: 'granted', canRequest: false },
      postEvent: { kind: 'post-event', state: 'granted', canRequest: false },
    },
    displays: [],
    ...update,
  }
}

describe('computer activity overlay', () => {
  it('summarizes computer work without exposing implementation details', () => {
    const result = computerOverlayPresentation(snapshot({
      activity: {
        phase: 'acting',
        appName: 'Keynote',
        description: '正在调整演示文稿',
        controlMode: 'foreground-visual',
        startedAt: 1,
      },
    }))
    expect(result).toEqual(expect.objectContaining({ title: 'Keynote', detail: '正在调整演示文稿', phase: 'active' }))
  })

  it('keeps a concise waiting state between computer operations', () => {
    const result = computerOverlayPresentation(snapshot(), {
      phase: 'acting',
      appName: 'Pages',
      description: '正在整理文档',
      controlMode: 'background-semantic',
      startedAt: 1,
    })
    expect(result).toEqual(expect.objectContaining({ title: 'Pages', detail: '正在准备下一步' }))
  })

  it('puts Computer approvals and control actions on the floating panel', () => {
    const result = computerOverlayPresentation(snapshot({
      activeApp: { pid: 101, name: 'Safari', bundleId: 'com.apple.Safari', active: true },
    }), undefined, false, {
      id: 'approval-1',
      kind: 'permission',
      question: '允许 TurboFlux 在 Safari 中点击内容吗？',
      toolName: 'computer__click',
      options: ['allow-once', 'allow-run', 'deny'],
    })

    expect(result).toMatchObject({
      title: 'Safari · 需要确认',
      phase: 'waiting',
      takeControl: true,
      resumeControl: false,
      stopControl: true,
      approval: {
        id: 'approval-1',
        options: [
          { value: 'allow-once', label: '仅这次允许', tone: 'primary' },
          { value: 'allow-run', label: '本任务自动', tone: 'normal' },
          { value: 'deny', label: '拒绝', tone: 'danger' },
        ],
      },
    })
    expect(computerOverlayApprovalOptions([])).toHaveLength(2)
  })

  it('centers inside negative-coordinate display work areas', () => {
    expect(computerOverlayBounds({ x: -1512, y: 24, width: 1512, height: 958 })).toEqual({
      x: -1166,
      y: 36,
      width: 820,
      height: 66,
    })
  })
})
