export type SkillMarketplaceTransport = 'github-api' | 'github-raw'
export type SkillMarketplaceCircuitState = 'closed' | 'open' | 'half-open'

export interface SkillMarketplaceRetryNotice {
  transport: SkillMarketplaceTransport
  attempt: number
  maxAttempts: number
  delayMs: number
  reason: string
}

export interface SkillMarketplaceCircuitSnapshot {
  transport: SkillMarketplaceTransport
  state: SkillMarketplaceCircuitState
  failures: number
  openedAt?: number
  retryAt?: number
}

export interface SkillMarketplaceRequestOptions<T> {
  transport: SkillMarketplaceTransport
  attempts: number
  timeoutMs: number
  signal?: AbortSignal
  onRetry?: (notice: SkillMarketplaceRetryNotice) => void
  consume(response: Response, signal: AbortSignal): Promise<T>
}

interface CircuitRecord {
  failures: number
  openedAt?: number
  probeInFlight: boolean
}

interface SkillMarketplaceRequestControllerOptions {
  failureThreshold?: number
  cooldownMs?: number
  now?: () => number
  random?: () => number
}

function abortError(): Error {
  return Object.assign(new Error('下载已取消'), { name: 'AbortError', code: 'SKILL_INSTALL_CANCELED' })
}

function retryAfterMs(response: Response, now: number): number | undefined {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(120_000, Math.round(seconds * 1_000))
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.min(120_000, Math.max(0, date - now)) : undefined
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolveDelay, rejectDelay) => {
    const finish = () => {
      signal?.removeEventListener('abort', onAbort)
      resolveDelay()
    }
    const timeout = setTimeout(finish, ms)
    const onAbort = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      rejectDelay(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function reasonFor(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export class SkillMarketplaceRequestController {
  private readonly circuits = new Map<SkillMarketplaceTransport, CircuitRecord>()
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private readonly now: () => number
  private readonly random: () => number

  constructor(options: SkillMarketplaceRequestControllerOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 3)
    this.cooldownMs = Math.max(1_000, options.cooldownMs ?? 30_000)
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
  }

  snapshots(): SkillMarketplaceCircuitSnapshot[] {
    return (['github-api', 'github-raw'] as SkillMarketplaceTransport[]).map(transport => {
      const record = this.record(transport)
      const state = this.stateFor(record)
      return {
        transport,
        state,
        failures: record.failures,
        openedAt: record.openedAt,
        retryAt: record.openedAt ? record.openedAt + this.cooldownMs : undefined,
      }
    })
  }

  async request<T>(url: string, init: RequestInit, options: SkillMarketplaceRequestOptions<T>): Promise<T> {
    const record = this.record(options.transport)
    const state = this.stateFor(record)
    if (state === 'open') {
      const retryAt = (record.openedAt || this.now()) + this.cooldownMs
      throw Object.assign(new Error(`下载源暂时不可用，将在 ${Math.max(1, Math.ceil((retryAt - this.now()) / 1_000))} 秒后自动恢复探测`), {
        code: 'SKILL_MARKETPLACE_CIRCUIT_OPEN',
        retryable: true,
        retryAt,
        transport: options.transport,
      })
    }
    if (state === 'half-open') record.probeInFlight = true

    let lastError: unknown
    try {
      for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
        if (options.signal?.aborted) throw abortError()
        const controller = new AbortController()
        const onAbort = () => controller.abort()
        options.signal?.addEventListener('abort', onAbort, { once: true })
        const timeout = setTimeout(() => controller.abort(), options.timeoutMs)
        let response: Response | undefined
        try {
          response = await fetch(url, { ...init, signal: controller.signal })
          if (!response.ok) {
            const retryable = response.status === 429 || response.status >= 500
            const error = Object.assign(new Error(`GitHub 返回 ${response.status}`), {
              code: 'SKILL_MARKETPLACE_HTTP_ERROR',
              retryable,
              status: response.status,
              retryAfterMs: retryAfterMs(response, this.now()),
            })
            throw error
          }
          const result = await options.consume(response, controller.signal)
          this.recordSuccess(record)
          return result
        } catch (error) {
          if (options.signal?.aborted) throw abortError()
          lastError = error
          const retryable = (error as { retryable?: boolean })?.retryable !== false
          if (!retryable) throw error
          if (attempt >= options.attempts) break
          const requestedDelay = (error as { retryAfterMs?: number })?.retryAfterMs
          const exponentialDelay = Math.min(8_000, 300 * (2 ** (attempt - 1)))
          const delayMs = requestedDelay ?? Math.round(exponentialDelay * (0.75 + this.random() * 0.5))
          options.onRetry?.({
            transport: options.transport,
            attempt,
            maxAttempts: options.attempts,
            delayMs,
            reason: reasonFor(error),
          })
          await delay(delayMs, options.signal)
        } finally {
          clearTimeout(timeout)
          options.signal?.removeEventListener('abort', onAbort)
          try { await response?.body?.cancel() } catch { /* consumed bodies may already be closed */ }
        }
      }
      this.recordFailure(record)
      throw lastError instanceof Error ? lastError : new Error('GitHub 请求失败')
    } finally {
      record.probeInFlight = false
    }
  }

  private record(transport: SkillMarketplaceTransport): CircuitRecord {
    let record = this.circuits.get(transport)
    if (!record) {
      record = { failures: 0, probeInFlight: false }
      this.circuits.set(transport, record)
    }
    return record
  }

  private stateFor(record: CircuitRecord): SkillMarketplaceCircuitState {
    if (!record.openedAt) return 'closed'
    if (this.now() - record.openedAt < this.cooldownMs) return 'open'
    return record.probeInFlight ? 'open' : 'half-open'
  }

  private recordSuccess(record: CircuitRecord): void {
    record.failures = 0
    record.openedAt = undefined
    record.probeInFlight = false
  }

  private recordFailure(record: CircuitRecord): void {
    record.failures += 1
    if (record.failures >= this.failureThreshold) record.openedAt = this.now()
  }
}
