export const INSPECTOR_MINIMUM_WIDTH = 320
export const INSPECTOR_DISMISS_TRIGGER_RATIO = .56
export const INSPECTOR_SIDEBAR_WIDTH = 300
export const INSPECTOR_MINIMUM_MAIN_WIDTH = 240

export function maximumInspectorWidth(viewportWidth: number): number {
  const available = viewportWidth - INSPECTOR_SIDEBAR_WIDTH - INSPECTOR_MINIMUM_MAIN_WIDTH
  return Math.max(INSPECTOR_MINIMUM_WIDTH, Math.min(viewportWidth * .72, available))
}

export function defaultInspectorWidth(viewportWidth: number): number {
  return Math.round(Math.min(420, Math.max(340, viewportWidth * .25)))
}

export function clampInspectorWidth(value: number, viewportWidth: number): number {
  return Math.round(Math.min(
    maximumInspectorWidth(viewportWidth),
    Math.max(INSPECTOR_MINIMUM_WIDTH, value),
  ))
}

export function inspectorDismissTriggerX(panelLeft: number, panelWidth: number): number {
  return Math.round(panelLeft + panelWidth * INSPECTOR_DISMISS_TRIGGER_RATIO)
}

export function shouldDismissInspectorAtPointer(pointerX: number, triggerX: number): boolean {
  return pointerX >= triggerX
}

export function inspectorWidthFromKey(
  currentWidth: number,
  key: string,
  accelerated: boolean,
  viewportWidth: number,
): number | null {
  if (key === 'Home') return clampInspectorWidth(defaultInspectorWidth(viewportWidth), viewportWidth)
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null
  const step = accelerated ? 48 : 16
  return clampInspectorWidth(currentWidth + (key === 'ArrowLeft' ? step : -step), viewportWidth)
}
