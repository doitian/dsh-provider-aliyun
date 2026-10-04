/**
 * Ask the endpoint which models it serves.
 *
 * DSH's model picker reads a route's advertised models through
 * `LlmAdapter.listModels()`, so a route answering from a file can only ever
 * list what its package shipped. This module makes that answer live: one
 * `GET {baseURL}/models`, the endpoint's own order, the endpoint's own ids.
 *
 * Three properties are deliberate, and each one is a failure mode avoided:
 *
 * - **No read waits longer than a bound.** `settle()` waits at most
 *   `maxWaitMs` for a cold or stale listing; every other read only *schedules*
 *   a refresh. A picker opened during a slow fetch shows the fallback catalog
 *   instead of hanging on the endpoint.
 * - **A failure never shrinks the route.** The last good listing stays in
 *   effect, and before the first good one the fallback catalog does. Only a
 *   successful listing changes what the route advertises, and a listing naming
 *   nothing counts as a failure: `{"data":[]}` says nothing about what an
 *   endpoint serves, so acting on it would empty the picker for no reason.
 * - **The credential is resolved per attempt.** The key can arrive long after
 *   mount — the credentials store is written at any time — so a failure is
 *   never cached as a conclusion; `credentials/reference-updated` and the
 *   failure backoff are what make the next attempt happen.
 *
 * @module @doitian/dsh-provider-aliyun/discovery
 */
import { LlmError, assertUsableApiKey, attributionHeaders } from '@deepseek-ai/dsh-llm'

import { ROUTE } from './catalog.js'

/** Endpoint replies larger than this are refused outright; a model list is never this big. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Idle bound on one listing request, so a black-holed endpoint cannot pin a read. */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000

/** How long a failed attempt is left alone before another read may retry it. */
export const FAILURE_RETRY_MS = 60_000

/** Protocol this route speaks; the only listing shape this module reads. */
const PROTOCOL = 'openai-completions'

/**
 * Join the configured endpoint with the listing path.
 *
 * The base is treated as a prefix rather than a URL to resolve against, so a
 * workspace path keeps its segments instead of losing them to `URL` resolution:
 * `https://…/compatible-mode/v1` lists at `https://…/compatible-mode/v1/models`.
 *
 * @param {string} baseURL - the route's configured endpoint.
 * @returns {string} the listing URL.
 */
export function listingUrl(baseURL) {
  return `${baseURL.replace(/\/+$/, '')}/models`
}

/** The first non-empty string among the candidates. */
function label(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/** The first positive integer among the candidates. */
function capacity(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

/** Whether a value is a plain object, which is what a listing row must be. */
function isRow(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one model listing.
 *
 * Three shapes are accepted because compatible endpoints disagree: the standard
 * `data` array (whose entries may be bare id strings), a `models` array, and the
 * enriched `models` map some gateways expose, where the property key is the id
 * the endpoint accepts and the nested `id` is a canonical name that may differ.
 * A row without a usable id is skipped rather than failing the read — one
 * malformed row should not deny the rest of a working endpoint.
 *
 * @param {unknown} body - the parsed reply.
 * @returns {{ id: string, name: string, contextWindow?: number, maxTokens?: number }[]} rows in endpoint order, deduplicated.
 * @throws {LlmError} when the reply is not a listing at all.
 */
export function parseListing(body) {
  const data = isRow(body) ? body.data : undefined
  const models = isRow(body) ? body.models : undefined
  let rows
  if (Array.isArray(data)) rows = data
  else if (Array.isArray(models)) rows = models
  else if (isRow(models)) {
    // The property key is the id the endpoint accepts; a nested `id` is only a
    // canonical name for an entry whose key is empty, because gateways put the
    // canonical identity there instead of the alias requests must use.
    rows = Object.entries(models)
      .filter(([, value]) => isRow(value))
      .map(([key, value]) => ({ ...value, id: key.length > 0 ? key : value.id }))
  } else {
    throw new LlmError(
      'llm-aliyun: the endpoint\'s model listing has neither a "data" array nor a "models" object',
      'DISCOVERY_FAILED',
    )
  }

  const seen = new Set()
  const listing = []
  for (const raw of rows) {
    const row = typeof raw === 'string' ? { id: raw } : raw
    if (!isRow(row)) continue
    const id = label(row.id)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const contextWindow = capacity(row.contextWindow, row.context_window, row.context_length, row.max_input_tokens, row.limit?.context)
    const maxTokens = capacity(row.maxOutputTokens, row.max_output_tokens, row.maxTokens, row.max_tokens, row.limit?.output, row.top_provider?.max_completion_tokens)
    listing.push({
      id,
      name: label(row.name, row.display_name, row.displayName) ?? id,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    })
  }
  return listing
}

/**
 * Read a reply body, refusing one that outgrows the ceiling.
 *
 * The declared length is checked first so an honest server is turned away
 * without transferring anything, but the accumulated total is what actually
 * enforces the bound: a server that under-declares tells us nothing up front.
 *
 * @param {Response} response - the listing reply.
 * @param {string} url - the URL, for the message.
 * @returns {Promise<string>} the decoded body.
 */
async function readBounded(response, url) {
  const oversized = () => new LlmError(`llm-aliyun: ${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw oversized()
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * Fetch and parse one endpoint's model listing.
 *
 * @param {object} input - the request.
 * @param {string} input.baseURL - endpoint to interrogate.
 * @param {string} [input.apiKey] - credential for this request; omitted sends none.
 * @param {Record<string, string>} [input.headers] - extra headers the deployment configures.
 * @param {number} [input.timeoutMs] - idle bound on the request.
 * @param {AbortSignal} [input.signal] - caller cancellation.
 * @param {typeof fetch} [input.fetchImpl] - transport, injected by tests.
 * @returns {Promise<{ id: string, name: string, contextWindow?: number, maxTokens?: number }[]>} the advertised models.
 * @throws {LlmError} when the endpoint refuses, fails, or answers something that is not a listing.
 */
export async function fetchListing({ baseURL, apiKey, headers, timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS, signal, fetchImpl = globalThis.fetch }) {
  const url = listingUrl(baseURL)
  const requestHeaders = new Headers(headers === undefined ? undefined : Object.entries(headers))
  requestHeaders.set('accept', 'application/json')
  if (apiKey !== undefined) requestHeaders.set('authorization', `Bearer ${apiKey}`)
  // Every provider HTTP request carries the harness attribution headers.
  for (const [name, value] of Object.entries(attributionHeaders())) requestHeaders.set(name, value)

  const bound = AbortSignal.timeout(timeoutMs)
  const composed = signal === undefined ? bound : AbortSignal.any([signal, bound])
  let response
  try {
    response = await fetchImpl(url, { method: 'GET', headers: requestHeaders, signal: composed })
  } catch (error) {
    const reached = signal?.aborted === true ? 'aborted by the caller' : `could not reach ${url}`
    throw new LlmError(`llm-aliyun: ${reached}`, signal?.aborted === true ? 'ABORTED' : 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    const advice = response.status === 401 || response.status === 403
      ? '; check the stored credential'
      : response.status === 404
        ? '; this endpoint serves no model listing, so the fallback catalog is what this route advertises'
        : ''
    throw new LlmError(`llm-aliyun: ${url} answered ${response.status}${advice}`, 'DISCOVERY_FAILED')
  }

  const text = await readBounded(response, url)
  let body
  try {
    body = JSON.parse(text)
  } catch (error) {
    throw new LlmError(`llm-aliyun: ${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
  return parseListing(body)
}

/** Resolve after `ms`, without holding the process open for it. */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Create the discovery state one mounted route owns.
 *
 * @param {object} options - route facts and callbacks.
 * @param {string} options.baseURL - the route's configured endpoint.
 * @param {string} options.apiKeyEnv - credential reference, named in diagnostics and validated.
 * @param {boolean} [options.enabled] - whether reads refresh the listing at all.
 * @param {number} [options.ttlMs] - how long a listing stays fresh.
 * @param {number} [options.timeoutMs] - idle bound on one listing request.
 * @param {Record<string, string>} [options.headers] - extra headers the deployment configures.
 * @param {readonly import('./catalog.js').AliyunModel[]} [options.fallbackModels] - entries whose facts a probe may report.
 * @param {() => Promise<string | undefined>} options.resolveApiKey - credential resolver.
 * @param {(ids: readonly string[]) => void} [options.onChange] - called when the advertised membership changes.
 * @param {(message: string) => void} [options.onError] - called once per distinct failure message.
 * @param {typeof fetch} [options.fetchImpl] - transport, injected by tests.
 * @param {() => number} [options.now] - clock, injected by tests.
 * @returns {object} the discovery state.
 */
export function createModelDiscovery(options) {
  const {
    baseURL,
    apiKeyEnv,
    enabled = true,
    ttlMs,
    timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
    headers,
    fallbackModels = [],
    resolveApiKey,
    onChange,
    onError,
    fetchImpl,
    now = () => Date.now(),
  } = options

  /** Endpoint order, `undefined` until a listing has ever been read. */
  let ids
  /** When the listing in effect was read. */
  let fetchedAt = 0
  /** When the last attempt started, successful or not, which is what paces retries. */
  let attemptedAt = -Infinity
  let failure
  let reportedFailure
  let inFlight

  const report = (error) => {
    failure = error instanceof Error ? error.message : String(error)
    if (failure !== reportedFailure) {
      reportedFailure = failure
      onError?.(failure)
    }
  }

  const succeed = (next) => {
    failure = undefined
    reportedFailure = undefined
    fetchedAt = now()
    const changed = ids === undefined || ids.length !== next.length || ids.some((id, index) => id !== next[index])
    ids = next
    if (changed) onChange?.(ids)
  }

  /** Whether another attempt is warranted right now. */
  const due = () => {
    if (ids === undefined) return now() - attemptedAt >= FAILURE_RETRY_MS
    return now() - fetchedAt >= ttlMs
  }

  /**
   * Read the listing unless one is fresh or in flight.
   *
   * Never rejects: a failure is reported through `onError` and leaves the
   * listing in effect untouched, because a route that cannot reach its endpoint
   * must still serve the models it already knows.
   *
   * @param {object} [options] - refresh options.
   * @param {boolean} [options.force] - read even when the current listing is fresh.
   * @returns {Promise<void>} settles when this attempt does.
   */
  const refresh = ({ force = false } = {}) => {
    if (!enabled) return Promise.resolve()
    if (inFlight !== undefined) return inFlight
    if (!force && !due()) return Promise.resolve()
    attemptedAt = now()
    inFlight = (async () => {
      try {
        const raw = await resolveApiKey()
        if (raw === undefined || raw.length === 0) {
          throw new LlmError(
            `llm-aliyun: no credential for provider route "${ROUTE}" — ${apiKeyEnv} is not set, so this route advertises its fallback catalog; store ${apiKeyEnv} to let it list what the endpoint serves`,
            'MISSING_CREDENTIAL',
          )
        }
        const apiKey = assertUsableApiKey(raw, 'llm-aliyun', apiKeyEnv)
        const listing = await fetchListing({ baseURL, apiKey, headers, timeoutMs, fetchImpl })
        if (listing.length === 0) {
          throw new LlmError(
            `llm-aliyun: ${listingUrl(baseURL)} listed no models, which says nothing about what it serves; keeping the ${ids === undefined ? 'fallback catalog' : 'previous listing'}`,
            'DISCOVERY_FAILED',
          )
        }
        succeed(listing.map((model) => model.id))
      } catch (error) {
        report(error)
      } finally {
        inFlight = undefined
      }
    })()
    return inFlight
  }

  /** Schedule a refresh when one is due, without waiting for it. */
  const ensureFresh = (refreshOptions) => {
    void refresh(refreshOptions)
  }

  /**
   * Answer a model-list read, waiting at most `maxWaitMs` for a listing that is
   * not in hand yet.
   *
   * @param {object} [options] - wait options.
   * @param {number} [options.maxWaitMs] - longest to wait; `0` only schedules.
   * @returns {Promise<void>} settles when the wait is over, whether or not the read succeeded.
   */
  const settle = async ({ maxWaitMs = 0 } = {}) => {
    if (!enabled || !due()) return
    const pending = inFlight ?? refresh()
    if (maxWaitMs <= 0) return
    await Promise.race([pending, delay(maxWaitMs)])
  }

  /**
   * Interrogate an endpoint on behalf of a configuration surface.
   *
   * This is what `ctx.llm.registerModelDiscovery` publishes: a draft carries its
   * own endpoint and one-shot credential, while a request that names no endpoint
   * is answered from this route's configuration. Capacities come from the
   * fallback catalog when it names the id, so an adopting surface receives facts
   * rather than having to invent them.
   *
   * @param {object} [request] - the draft being interrogated.
   * @param {string} [request.provider] - route the draft edits, when it edits one.
   * @param {string} [request.baseURL] - endpoint to interrogate.
   * @param {string} [request.api] - protocol the draft names.
   * @param {string} [request.apiKey] - credential for this interrogation alone.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<object[]>} the advertised models, in endpoint order.
   * @throws {LlmError} when the request cannot be served or the endpoint refuses.
   */
  const probe = async (request = {}, signal) => {
    const provider = label(request.provider)
    const endpoint = label(request.baseURL)
    const api = label(request.api)
    if (api !== undefined && api !== PROTOCOL) {
      throw new LlmError(`llm-aliyun: this route speaks ${PROTOCOL}, not "${api}", and cannot list models for it`, 'DISCOVERY_UNSUPPORTED')
    }
    if (endpoint === undefined && provider !== undefined && provider !== 'aliyun') {
      throw new LlmError(`llm-aliyun: the draft names route "${provider}", which this plugin does not own; give its endpoint to interrogate it`, 'DISCOVERY_UNSUPPORTED')
    }
    const supplied = label(request.apiKey)
    const apiKey = supplied === undefined ? await resolveApiKey() : supplied
    const listing = await fetchListing({
      baseURL: endpoint ?? baseURL,
      ...apiKey === undefined || apiKey.length === 0 ? {} : { apiKey: assertUsableApiKey(apiKey, 'llm-aliyun', apiKeyEnv) },
      headers,
      timeoutMs,
      signal,
      fetchImpl,
    })
    const known = new Map(fallbackModels.map((entry) => [entry.id, entry]))
    return listing.map((model) => {
      const entry = known.get(model.id)
      const contextWindow = model.contextWindow ?? entry?.contextWindow
      const maxTokens = model.maxTokens ?? entry?.maxTokens
      const input = entry?.input
      return {
        id: model.id,
        name: model.name,
        ...contextWindow === undefined ? {} : { contextWindow },
        ...maxTokens === undefined ? {} : { maxTokens },
        ...input === undefined ? {} : { inputModalities: [...input] },
      }
    })
  }

  return {
    /** Whether reads refresh at all. */
    get enabled() {
      return enabled
    },
    /** The ids in effect, or `undefined` before any listing. */
    ids: () => ids,
    /** When the listing in effect was read, or `0`. */
    fetchedAt: () => fetchedAt,
    /** The last failure message, cleared by a successful read. */
    error: () => failure,
    refresh,
    ensureFresh,
    settle,
    probe,
  }
}
