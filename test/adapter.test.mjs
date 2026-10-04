/**
 * Drive the real `PiAiAdapter` from `@deepseek-ai/dsh-llm-pi-ai` against this
 * package's factory.
 *
 * This is the guard for the one thing that cannot be checked statically: that
 * the resolved profile built in `lib/adapter.js` is still the shape the adapter
 * consumes. `PiAiAdapter` reads a route profile that its own package never
 * exports as a type, so a DSH upgrade that starts reading a new field, or stops
 * reading one of these, is invisible to the validator and to review. Here it
 * fails a test instead.
 *
 * A live request is out of scope: that needs a real key and a real endpoint.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createAliyunAdapter, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../lib/adapter.js'
import { ALIYUN_MODELS, DEFAULT_API_KEY_ENV, DEFAULT_BASE_URL, ROUTE } from '../lib/catalog.js'
import { apply } from '../lib/index.js'

/** Build an adapter over the shipped catalog, with a stub credential. */
function makeAdapter(overrides = {}) {
  return createAliyunAdapter({
    displayName: 'Aliyun DashScope',
    apiKeyEnv: DEFAULT_API_KEY_ENV,
    baseURL: DEFAULT_BASE_URL,
    models: ALIYUN_MODELS,
    reasoning: undefined,
    headers: undefined,
    resolveApiKey: async () => 'test-key',
    ...overrides,
  })
}

test('advertises exactly the shipped catalog', async () => {
  const models = await makeAdapter().listModels(ROUTE)
  assert.deepEqual(
    models.map((model) => model.id),
    ALIYUN_MODELS.map((model) => model.id),
  )
  for (const model of models) {
    assert.equal(model.provider, ROUTE)
    assert.equal(model.name, ALIYUN_MODELS.find((entry) => entry.id === model.id).name)
    assert.ok(Array.isArray(model.inputModalities) && model.inputModalities.length > 0)
  }
})

test('reports model metadata from the catalog, not from configuration', async () => {
  const adapter = makeAdapter()
  const info = await adapter.resolveModel(ROUTE, 'qwen3.8-max')
  const entry = ALIYUN_MODELS.find((model) => model.id === 'qwen3.8-max')

  assert.equal(info.id, 'qwen3.8-max')
  assert.equal(info.provider, ROUTE)
  assert.deepEqual(info.inputModalities, entry.input)
  assert.equal(info.context.contextWindow, entry.contextWindow)
  // The catalog declares thinking levels, so the harness must be offered them.
  assert.ok(info.reasoning !== undefined, 'a reasoning model must expose reasoning metadata')
})

test('names the route from configuration', async () => {
  const adapter = makeAdapter({ displayName: 'My Aliyun' })
  assert.deepEqual(adapter.providerInfo(ROUTE), { id: ROUTE, name: 'My Aliyun' })
})

test('refuses a model the catalog does not describe', async () => {
  await assert.rejects(
    () => makeAdapter().resolveModel(ROUTE, 'qwen-does-not-exist'),
    /UNKNOWN_MODEL|no configured model/,
  )
})

test('fails a missing credential before any network I/O', async () => {
  const adapter = makeAdapter({
    resolveApiKey: async () => {
      throw new Error('llm-aliyun: no credential for provider route "aliyun" (MISSING_CREDENTIAL)')
    },
  })
  await assert.rejects(async () => {
    for await (const _chunk of adapter.stream({
      provider: ROUTE,
      model: 'qwen3.8-max',
      messages: [],
    })) {
      assert.fail('a request without a credential must not stream')
    }
  }, /MISSING_CREDENTIAL/)
})

test('the adapter carries an idle watchdog bound', () => {
  // Guards against the profile silently losing a field the adapter reads to
  // bound a stalled stream; a zero or absent value would disable the watchdog.
  assert.ok(Number.isFinite(DEFAULT_STREAM_IDLE_TIMEOUT_MS) && DEFAULT_STREAM_IDLE_TIMEOUT_MS > 0)
})

test('mounting registers the route and its settings row', () => {
  const adapters = []
  const directory = []
  const ctx = {
    fiber: { entry: { options: { id: 'llm-aliyun' } } },
    llm: {
      registerAdapter: (routes, adapter) => {
        adapters.push({ routes, adapter })
        return { replace() {} }
      },
      registerConfigurableProviders: (entries) => {
        directory.push(entries)
        return { replace() {} }
      },
    },
    get: () => undefined,
    logger: { warn() {} },
  }

  apply(ctx, {
    displayName: 'Aliyun DashScope',
    apiKeyEnv: DEFAULT_API_KEY_ENV,
    baseURL: DEFAULT_BASE_URL,
    models: ALIYUN_MODELS,
    reasoning: undefined,
    headers: undefined,
  })

  assert.equal(adapters.length, 1)
  assert.deepEqual(adapters[0].routes, [ROUTE])
  assert.equal(adapters[0].adapter.constructor.name, 'PiAiAdapter')

  assert.equal(directory.length, 1)
  const [entry] = directory[0]
  assert.equal(entry.provider, ROUTE)
  assert.equal(entry.settingsNs, 'llm-aliyun')
  assert.equal(entry.declared, true)
  assert.deepEqual(entry.settingsPath, [])
})
