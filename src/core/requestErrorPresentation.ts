function extractProviderMessage(value: string): string {
  const trimmed = value.trim()
  const jsonStart = trimmed.indexOf('{')
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart)) as Record<string, unknown>
      const error = parsed.error
      if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
        return (error as Record<string, unknown>).message as string
      }
      if (typeof parsed.message === 'string') return parsed.message
    } catch {}
  }
  return trimmed.replace(/^HTTP\s+\d+\s*:\s*/i, '')
}

function sanitizeProviderMessage(value: string): string {
  return extractProviderMessage(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[已隐藏]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320)
}

export function presentRequestError(error: string): string {
  const normalized = error.toLowerCase()
  if (/unknown variant [`'\"]?image_url|image_url.*expected [`'\"]?text|image (?:input|content).*(?:not supported|unsupported)|vision.*(?:not supported|unsupported)/.test(normalized)) {
    return '当前模型不支持图像输入。截图已保留在对话中，请切换支持视觉的模型后重试，或让 Agent 继续使用页面文字信息。'
  }
  if (/insufficient[_ -]?(quota|credit)|quota.*(exceed|insufficient)|credit.*(exhaust|insufficient)|balance|billing|余额|额度|配额|积分不足/.test(normalized)) {
    return '当前模型服务额度不足，请充值或切换可用模型后重试。'
  }
  if (/\b(401|403)\b|invalid[_ -]?api[_ -]?key|authentication|unauthorized|forbidden|认证失败|密钥无效/.test(normalized)) {
    return '模型服务认证失败，请检查服务配置后重试。'
  }
  if (/\b429\b|rate[_ -]?limit|too many requests|请求过于频繁/.test(normalized)) {
    return '模型服务当前请求过多，请稍后重试。'
  }
  if (/timed? out|timeout|超时/.test(normalized)) {
    return '模型服务响应超时，请稍后重试。'
  }
  if (/\b(500|502|503|504)\b|service unavailable|temporarily unavailable|服务不可用/.test(normalized)) {
    return '模型服务暂时不可用，请稍后重试。'
  }
  const detail = sanitizeProviderMessage(error)
  return detail ? `模型服务返回：${detail}` : '模型服务请求失败，请稍后重试。'
}
