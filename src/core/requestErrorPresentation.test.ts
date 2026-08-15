import { describe, expect, it } from 'vitest'
import { presentRequestError } from './requestErrorPresentation'

describe('request error presentation', () => {
  it('turns quota failures into a clear action', () => {
    expect(presentRequestError('HTTP 402: {"error":{"message":"insufficient balance","code":"insufficient_quota"}}'))
      .toBe('当前模型服务额度不足，请充值或切换可用模型后重试。')
  })

  it('distinguishes authentication, throttling, and service availability', () => {
    expect(presentRequestError('HTTP 401: invalid_api_key')).toBe('模型服务认证失败，请检查服务配置后重试。')
    expect(presentRequestError('HTTP 429: rate_limit_exceeded')).toBe('模型服务当前请求过多，请稍后重试。')
    expect(presentRequestError('HTTP 503: upstream unavailable')).toBe('模型服务暂时不可用，请稍后重试。')
  })

  it('keeps an unknown provider reason while hiding credentials', () => {
    expect(presentRequestError('HTTP 400: bad request for sk-secretvalue123456'))
      .toBe('模型服务返回：bad request for [已隐藏]')
  })

  it('turns a text-only image rejection into a useful model capability action', () => {
    expect(presentRequestError('Failed to deserialize the JSON body into the target type: messages[16]: unknown variant `image_url`, expected `text`'))
      .toBe('当前模型不支持图像输入。截图已保留在对话中，请切换支持视觉的模型后重试，或让 Agent 继续使用页面文字信息。')
  })
})
