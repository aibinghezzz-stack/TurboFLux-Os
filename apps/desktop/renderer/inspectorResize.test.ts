import { describe, expect, it } from 'vitest'
import {
  INSPECTOR_DISMISS_TRIGGER_RATIO,
  INSPECTOR_MINIMUM_WIDTH,
  clampInspectorWidth,
  defaultInspectorWidth,
  inspectorDismissTriggerX,
  inspectorWidthFromKey,
  maximumInspectorWidth,
  shouldDismissInspectorAtPointer,
} from './inspectorResize'

describe('inspector resize interaction', () => {
  it('uses responsive defaults and hard width bounds', () => {
    expect(defaultInspectorWidth(1_440)).toBe(662)
    expect(defaultInspectorWidth(2_000)).toBe(760)
    expect(maximumInspectorWidth(1_000)).toBe(460)
    expect(clampInspectorWidth(100, 1_000)).toBe(INSPECTOR_MINIMUM_WIDTH)
    expect(clampInspectorWidth(900, 1_000)).toBe(460)
  })

  it('dismisses only after the pointer crosses the panel midpoint toward the right', () => {
    const trigger = inspectorDismissTriggerX(700, 500)
    expect(trigger).toBe(Math.round(700 + 500 * INSPECTOR_DISMISS_TRIGGER_RATIO))
    expect(shouldDismissInspectorAtPointer(trigger - 1, trigger)).toBe(false)
    expect(shouldDismissInspectorAtPointer(trigger, trigger)).toBe(true)
    expect(shouldDismissInspectorAtPointer(trigger + 120, trigger)).toBe(true)
  })

  it('widens left, narrows right, and accelerates with Shift', () => {
    expect(inspectorWidthFromKey(600, 'ArrowLeft', false, 1_440)).toBe(616)
    expect(inspectorWidthFromKey(600, 'ArrowRight', false, 1_440)).toBe(584)
    expect(inspectorWidthFromKey(600, 'ArrowLeft', true, 1_440)).toBe(648)
    expect(inspectorWidthFromKey(600, 'ArrowRight', true, 1_440)).toBe(552)
  })

  it('resets with Home, clamps keyboard changes, and ignores other keys', () => {
    expect(inspectorWidthFromKey(500, 'Home', false, 1_440)).toBe(662)
    expect(inspectorWidthFromKey(420, 'ArrowRight', true, 1_440)).toBe(420)
    expect(inspectorWidthFromKey(640, 'ArrowLeft', true, 1_440)).toBe(688)
    expect(inspectorWidthFromKey(600, 'Enter', false, 1_440)).toBeNull()
  })
})
