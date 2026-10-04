/**
 * Exercise discovery without a network: the listing parser, the membership
 * merge, and the state machine that decides when the endpoint is asked.
 *
 * A live request is out of scope here — that needs a real key and a real
 * endpoint. What is in scope is every decision this package makes *around* the
 * request: which shapes it reads, what a failure leaves in place, and how long
 * a read is allowed to wait.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { FALLBACK_MODELS } from '../lib/catalog.js'
import {
  FAILURE_RETRY_MS,
  createModelDiscovery,
  fetchListing,
  listingUrl,
  parseListing,
} from '../lib/discovery.js'
import { mergeCatalog } from '../lib/models.js'

const DEFAULTS = { contextWindow: 131_072, maxTokens: 32_768, input: ['text'] }

/** A `fetch` that answers one listing and records every call it received. */
function listingFetch(ids, { status = 200, body } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    const payload = body ?? { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
  impl.calls = calls
  return impl
}

/** Discovery over the shipped fallback, with an injected transport and clock. */
function makeDiscovery(overrides = {}) {
  const clock = { at: 0 }
  const discovery = createModelDiscovery({
    baseURL: 'https://llm-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'ALIYUN_API_KEY',
    enabled: true,
    ttlMs: 600_000,
    timeoutMs: 15_000,
    fallbackModels: FALLBACK_MODELS,
    resolveApiKey: async () => 'sk-test',
    onChange: overrides.onChange,
    onError: overrides.onError,
    fetchImpl: overrides.fetchImpl,
    now: () => clock.at,
    ...overrides,
  })
  return { discovery, clock }
}

test('lists at the endpoint with the listing path appended', () => {
  assert.equal(listingUrl('https://example.test/compatible-mode/v1'), 'https://example.test/compatible-mode/v1/models')
  assert.equal(listingUrl('https://example.test/compatible-mode/v1/'), 'https://example.test/compatible-mode/v1/models')
  assert.equal(listingUrl('https://example.test/v1///'), 'https://example.test/v1/models')
})

test('reads the standard data array, bare ids, and the enriched models map', () => {
  assert.deepEqual(parseListing({ data: [{ id: 'glm-5.3' }, { id: 'kimi-k2.5', name: 'Kimi K2.5' }] }), [
    { id: 'glm-5.3', name: 'glm-5.3' },
    { id: 'kimi-k2.5', name: 'Kimi K2.5' },
  ])
  assert.deepEqual(parseListing({ data: ['qwen3.8-max'] }), [{ id: 'qwen3.8-max', name: 'qwen3.8-max' }])
  assert.deepEqual(parseListing({ models: { 'deepseek-v4.1-flash': { id: 'deepseek-v4.1-flash' } } }), [
    { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' },
  ])
})

test('keeps the map key as the id, skips malformed rows, and reads capacities', () => {
  const listing = parseListing({
    models: {
      'vendor-alias': { id: 'canonical-name', context_window: 256_000, max_output_tokens: 32_000 },
      '': { id: 'from-empty-key' },
      bad: 'not an object',
      worse: null,
    },
  })
  assert.deepEqual(listing, [
    { id: 'vendor-alias', name: 'vendor-alias', contextWindow: 256_000, maxTokens: 32_000 },
    { id: 'from-empty-key', name: 'from-empty-key' },
  ])
})

test('deduplicates ids, accepts a bare models array, and refuses a reply that is no listing', () => {
  assert.deepEqual(parseListing({ data: [{ id: 'glm-5.3' }, { id: 'glm-5.3' }] }), [{ id: 'glm-5.3', name: 'glm-5.3' }])
  assert.deepEqual(parseListing({ models: ['glm-5.3'] }), [{ id: 'glm-5.3', name: 'glm-5.3' }])
  assert.throws(() => parseListing({}), /neither a "data" array nor a "models" object/)
  assert.throws(() => parseListing({ data: 'nope' }), /neither a "data" array nor a "models" object/)
})

test('a listing request carries the key and the harness attribution headers', async () => {
  const fetchImpl = listingFetch(['glm-5.3'])
  const listing = await fetchListing({ baseURL: 'https://example.test/v1', apiKey: 'sk-test', fetchImpl })

  assert.deepEqual(listing, [{ id: 'glm-5.3', name: 'glm-5.3' }])
  const [call] = fetchImpl.calls
  assert.equal(call.url, 'https://example.test/v1/models')
  assert.equal(call.init.headers.get('authorization'), 'Bearer sk-test')
  assert.equal(call.init.headers.get('accept'), 'application/json')
  assert.ok((call.init.headers.get('user-agent') ?? '').length > 0, 'attribution headers must ride along')
})

test('an endpoint failure names the URL and the status', async () => {
  await assert.rejects(
    () => fetchListing({ baseURL: 'https://example.test/v1', apiKey: 'sk-test', fetchImpl: listingFetch([], { status: 404 }) }),
    /answered 404.*no model listing/,
  )
  await assert.rejects(
    () => fetchListing({ baseURL: 'https://example.test/v1', fetchImpl: listingFetch([], { status: 401 }) }),
    /answered 401.*check the stored credential/,
  )
})

test('membership follows the listing, and an unnamed id gets the conservative defaults', () => {
  const merged = mergeCatalog({ ids: ['glm-5.3', 'brand-new-model'], fallback: FALLBACK_MODELS, defaults: DEFAULTS })

  assert.deepEqual(merged.map((entry) => entry.id), ['glm-5.3', 'brand-new-model'])
  assert.equal(merged[0].contextWindow, FALLBACK_MODELS.find((entry) => entry.id === 'glm-5.3').contextWindow)
  assert.deepEqual(merged[1], {
    id: 'brand-new-model',
    name: 'brand-new-model',
    contextWindow: 131_072,
    maxTokens: 32_768,
    input: ['text'],
    reasoning: false,
  })
})

test('no listing yet leaves the fallback catalog in charge', () => {
  assert.deepEqual(
    mergeCatalog({ ids: undefined, fallback: FALLBACK_MODELS, defaults: DEFAULTS }).map((entry) => entry.id),
    FALLBACK_MODELS.map((entry) => entry.id),
  )
})

test('a first listing replaces the fallback membership and reports the change', async () => {
  const changes = []
  const fetchImpl = listingFetch(['glm-5.3', 'deepseek-v4.1-flash', 'kimi-k2.5'])
  const { discovery } = makeDiscovery({ fetchImpl, onChange: (ids) => changes.push(ids) })

  await discovery.settle({ maxWaitMs: 1_000 })

  assert.deepEqual(discovery.ids(), ['glm-5.3', 'deepseek-v4.1-flash', 'kimi-k2.5'])
  assert.deepEqual(changes, [['glm-5.3', 'deepseek-v4.1-flash', 'kimi-k2.5']])
  assert.equal(fetchImpl.calls.length, 1)
})

test('a fresh listing is not fetched again, and an expired one is', async () => {
  const fetchImpl = listingFetch(['glm-5.3'])
  const { discovery, clock } = makeDiscovery({ fetchImpl })

  await discovery.refresh()
  await discovery.refresh()
  assert.equal(fetchImpl.calls.length, 1, 'a listing inside its TTL is reused')

  clock.at += 600_001
  await discovery.refresh()
  assert.equal(fetchImpl.calls.length, 2, 'a stale listing is re-read')
})

test('a failed read keeps the models already in effect and reports once', async () => {
  const errors = []
  const failing = listingFetch([], { status: 500 })
  const { discovery } = makeDiscovery({ fetchImpl: failing, onError: (message) => errors.push(message) })

  await discovery.refresh()
  await discovery.refresh({ force: true })

  assert.equal(discovery.ids(), undefined)
  assert.match(discovery.error(), /answered 500/)
  assert.equal(errors.length, 1, 'the same failure is reported once, not once per attempt')
})

test('a listing that names nothing is refused rather than emptying the route', async () => {
  const errors = []
  const { discovery } = makeDiscovery({ fetchImpl: listingFetch([]), onError: (message) => errors.push(message) })

  await discovery.refresh()

  assert.equal(discovery.ids(), undefined)
  assert.match(errors[0], /listed no models/)
})

test('a missing credential is reported without touching the network', async () => {
  const errors = []
  const fetchImpl = listingFetch(['glm-5.3'])
  const { discovery } = makeDiscovery({
    fetchImpl,
    resolveApiKey: async () => undefined,
    onError: (message) => errors.push(message),
  })

  await discovery.refresh()

  assert.equal(fetchImpl.calls.length, 0)
  assert.match(errors[0], /MISSING_CREDENTIAL|ALIYUN_API_KEY is not set/)
})

test('a read that has already failed does not wait for the retry window', async () => {
  const fetchImpl = listingFetch([], { status: 503 })
  const { discovery, clock } = makeDiscovery({ fetchImpl })

  await discovery.settle({ maxWaitMs: 1_000 })
  const afterFirst = fetchImpl.calls.length

  clock.at += FAILURE_RETRY_MS - 1
  await discovery.settle({ maxWaitMs: 1_000 })
  assert.equal(fetchImpl.calls.length, afterFirst, 'inside the backoff nothing is attempted, so nothing is waited for')

  clock.at += 2
  await discovery.settle({ maxWaitMs: 1_000 })
  assert.equal(fetchImpl.calls.length, afterFirst + 1, 'past the backoff the endpoint is asked again')
})

test('disabled discovery never asks the endpoint', async () => {
  const fetchImpl = listingFetch(['glm-5.3'])
  const { discovery } = makeDiscovery({ fetchImpl, enabled: false })

  await discovery.settle({ maxWaitMs: 1_000 })
  await discovery.refresh({ force: true })

  assert.equal(fetchImpl.calls.length, 0)
  assert.equal(discovery.ids(), undefined)
})

test('a probe answers with the capacities this package already knows', async () => {
  const fetchImpl = listingFetch(['glm-5.3', 'unknown-model'])
  const { discovery } = makeDiscovery({ fetchImpl })

  const models = await discovery.probe({ provider: 'aliyun' })

  assert.deepEqual(models[0], {
    id: 'glm-5.3',
    name: 'glm-5.3',
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    inputModalities: ['text'],
  })
  assert.deepEqual(models[1], { id: 'unknown-model', name: 'unknown-model' })
})

test('a probe interrogates the draft endpoint and refuses what it cannot serve', async () => {
  const fetchImpl = listingFetch(['glm-5.3'])
  const { discovery } = makeDiscovery({ fetchImpl })

  await discovery.probe({ baseURL: 'https://other.test/v1', apiKey: 'sk-draft' })
  assert.equal(fetchImpl.calls[0].url, 'https://other.test/v1/models')
  assert.equal(fetchImpl.calls[0].init.headers.get('authorization'), 'Bearer sk-draft')

  await assert.rejects(() => discovery.probe({ api: 'anthropic-messages' }), /speaks openai-completions/)
  await assert.rejects(() => discovery.probe({ provider: 'somebody-else' }), /does not own/)
})
