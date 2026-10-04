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

import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'

import { createAliyunAdapter, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../lib/adapter.js'
import {
  CHAT_MODEL_PATTERNS,
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  FALLBACK_MODELS,
  NON_CHAT_MODEL_PATTERNS,
  ROUTE,
} from '../lib/catalog.js'
import { apply } from '../lib/index.js'
import { mergeCatalog } from '../lib/models.js'

const DEFAULTS = { contextWindow: 131_072, maxTokens: 32_768, input: ['text'] }

/**
 * Build an adapter over the fallback catalog, with a stub credential.
 *
 * The route facts arrive as a getter, matching what the mount passes: the plugin
 * reads its configuration fresh so a settings write moves the route under a
 * mounted adapter. `facts` is returned so a test can move one and prove it.
 */
function makeAdapter(overrides = {}) {
  const {
    displayName = 'Aliyun DashScope',
    apiKeyEnv = DEFAULT_API_KEY_ENV,
    baseURL = DEFAULT_BASE_URL,
    reasoning,
    headers,
    ...rest
  } = overrides
  const facts = { displayName, apiKeyEnv, baseURL, reasoning, headers }
  return {
    ...createAliyunAdapter({ facts: () => facts, models: FALLBACK_MODELS, resolveApiKey: async () => 'test-key', ...rest }),
    facts,
  }
}

test('advertises exactly the fallback catalog before any listing arrives', async () => {
  const { adapter } = makeAdapter()
  const models = await adapter.listModels(ROUTE)
  assert.deepEqual(
    models.map((model) => model.id),
    FALLBACK_MODELS.map((model) => model.id),
  )
  for (const model of models) {
    assert.equal(model.provider, ROUTE)
    assert.equal(model.name, FALLBACK_MODELS.find((entry) => entry.id === model.id).name)
    assert.ok(Array.isArray(model.inputModalities) && model.inputModalities.length > 0)
  }
})

test('reports model metadata from the catalog, not from configuration', async () => {
  const { adapter } = makeAdapter()
  const info = await adapter.resolveModel(ROUTE, 'qwen3.8-max')
  const entry = FALLBACK_MODELS.find((model) => model.id === 'qwen3.8-max')

  assert.equal(info.id, 'qwen3.8-max')
  assert.equal(info.provider, ROUTE)
  assert.deepEqual(info.inputModalities, entry.input)
  assert.equal(info.context.contextWindow, entry.contextWindow)
  // The catalog declares thinking levels, so the harness must be offered them.
  assert.ok(info.reasoning !== undefined, 'a reasoning model must expose reasoning metadata')
})

test('a discovered catalog replaces the advertised membership', async () => {
  const { adapter, setCatalog } = makeAdapter()
  setCatalog(mergeCatalog({
    ids: ['glm-5.3', 'brand-new-model'],
    fallback: FALLBACK_MODELS,
    defaults: DEFAULTS,
  }))

  const models = await adapter.listModels(ROUTE)
  assert.deepEqual(models.map((model) => model.id), ['glm-5.3', 'brand-new-model'])

  // A known id keeps its verified capacities; an unknown one is still usable.
  const known = await adapter.resolveModel(ROUTE, 'glm-5.3')
  assert.equal(known.context.contextWindow, FALLBACK_MODELS.find((entry) => entry.id === 'glm-5.3').contextWindow)
  const discovered = await adapter.resolveModel(ROUTE, 'brand-new-model')
  assert.equal(discovered.context.contextWindow, DEFAULTS.contextWindow)
  assert.equal(discovered.reasoning, undefined, 'an unknown model must not claim thinking it may not have')

  // Membership follows the listing, removals included.
  await assert.rejects(() => adapter.resolveModel(ROUTE, 'qwen3.8-max'), /UNKNOWN_MODEL|no configured model/)
})

test('a model list waits for a cold listing, and adopts what arrives', async () => {
  const ids = ['glm-5.3', 'kimi-k2.5']
  let settled = 0
  const { adapter, setCatalog } = makeAdapter({
    settle: async () => {
      settled += 1
      setCatalog(mergeCatalog({ ids, fallback: FALLBACK_MODELS, defaults: DEFAULTS }))
    },
  })

  const models = await adapter.listModels(ROUTE)

  assert.equal(settled, 1, 'the model list is the read allowed to wait for discovery')
  assert.deepEqual(models.map((model) => model.id), ids)
})

test('other reads only schedule a refresh, never wait for one', async () => {
  let scheduled = 0
  const { adapter } = makeAdapter({
    onRead: () => {
      scheduled += 1
    },
    settle: () => {
      throw new Error('only a model list may wait for discovery')
    },
  })

  adapter.providerInfo(ROUTE)
  await adapter.resolveModel(ROUTE, 'qwen3.8-max')

  assert.equal(scheduled, 2, 'every read is a moment a stale listing can be noticed')
})

test('names the route from configuration', async () => {
  const { adapter } = makeAdapter({ displayName: 'My Aliyun' })
  assert.deepEqual(adapter.providerInfo(ROUTE), { id: ROUTE, name: 'My Aliyun' })
})

test('refuses a model the catalog does not describe', async () => {
  const { adapter } = makeAdapter()
  await assert.rejects(
    () => adapter.resolveModel(ROUTE, 'qwen-does-not-exist'),
    /UNKNOWN_MODEL|no configured model/,
  )
})

test('fails a missing credential before any network I/O', async () => {
  const { adapter } = makeAdapter({
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

test('mounting registers the route, its settings row, and its discovery', () => {
  const adapters = []
  const directory = []
  const discoveries = []
  const credentialListeners = []
  const presentations = []
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
      registerModelDiscovery: (settingsNs, discover) => {
        discoveries.push({ settingsNs, discover })
        return () => {}
      },
    },
    inject: (names, callback) => {
      assert.deepEqual(names, ['settings'])
      callback({
        effect: (register) => {
          register()
        },
        settings: {
          configure: (policy, owner) => {
            presentations.push({ policy, owner })
            return () => {}
          },
        },
      })
    },
    on: (event, listener) => {
      credentialListeners.push({ event, listener })
    },
    get: () => undefined,
    logger: { warn() {}, debug() {} },
  }

  apply(ctx, {
    displayName: 'Aliyun DashScope',
    apiKeyEnv: DEFAULT_API_KEY_ENV,
    baseURL: DEFAULT_BASE_URL,
    models: FALLBACK_MODELS,
    reasoning: undefined,
    headers: undefined,
    discovery: {
      enabled: true,
      filter: 'chat',
      include: [...CHAT_MODEL_PATTERNS],
      exclude: [...NON_CHAT_MODEL_PATTERNS],
      ttlMs: 600_000,
      waitMs: 0,
      timeoutMs: 15_000,
      contextWindow: DEFAULTS.contextWindow,
      maxTokens: DEFAULTS.maxTokens,
      input: DEFAULTS.input,
    },
  })

  assert.equal(adapters.length, 1)
  assert.deepEqual(adapters[0].routes, [ROUTE])
  assert.ok(adapters[0].adapter instanceof PiAiAdapter, 'the registered adapter must be the real pi-ai adapter')
  assert.equal(typeof adapters[0].adapter.listModels, 'function')

  assert.equal(directory.length, 1)
  const [entry] = directory[0]
  assert.equal(entry.provider, ROUTE)
  assert.equal(entry.settingsNs, 'llm-aliyun')
  assert.equal(entry.declared, true)
  assert.deepEqual(entry.settingsPath, [])

  // The probe a configuration surface uses is registered under this row's own
  // namespace, and the credential event is what retries a failed listing.
  assert.equal(discoveries.length, 1)
  assert.equal(discoveries[0].settingsNs, 'llm-aliyun')
  assert.equal(typeof discoveries[0].discover, 'function')
  assert.deepEqual(
    credentialListeners.map((listener) => listener.event),
    ['credentials/reference-updated', 'settings/document-updated'],
  )

  // The plugin ships its own Models-page card, so it tells the settings service
  // not to auto-generate a page from its schema.
  assert.deepEqual(presentations, [{ policy: { auto: false }, owner: ctx.fiber }])
})

test('a listing that arrives moves the catalog and tells the surfaces', async () => {
  // A model picker caches the catalog it read and re-reads it only when the LLM
  // seam publishes `llm/adapters-updated`, so a swap nobody announces leaves the
  // fallback list on screen. This drives the real mount path with a stubbed
  // endpoint and asserts both halves: the catalog moved, and it was announced.
  const replaced = []
  const adapters = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(
    JSON.stringify({ object: 'list', data: [{ id: 'glm-5.3' }, { id: 'kimi-k3' }, { id: 'qwen3-tts-flash' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

  try {
    const ctx = {
      fiber: { entry: { options: { id: 'llm-aliyun' } } },
      llm: {
        registerAdapter: (routes, adapter) => {
          adapters.push({ routes, adapter })
          return {
            replace: (next) => replaced.push(next),
          }
        },
        registerConfigurableProviders: () => ({ replace() {} }),
        registerModelDiscovery: () => () => {},
      },
      on: () => {},
      inject: () => {},
      get: (name) => (name === 'credentials' ? { resolve: async () => ({ value: 'sk-test' }) } : undefined),
      logger: { warn() {}, debug() {} },
    }

    apply(ctx, {
      displayName: 'Aliyun DashScope',
      apiKeyEnv: DEFAULT_API_KEY_ENV,
      baseURL: DEFAULT_BASE_URL,
      models: FALLBACK_MODELS,
      reasoning: undefined,
      headers: undefined,
      discovery: {
        enabled: true,
        filter: 'chat',
        include: [...CHAT_MODEL_PATTERNS],
        exclude: [...NON_CHAT_MODEL_PATTERNS],
        ttlMs: 600_000,
        waitMs: 50,
        timeoutMs: 15_000,
        contextWindow: DEFAULTS.contextWindow,
        maxTokens: DEFAULTS.maxTokens,
        input: DEFAULTS.input,
      },
    })

    for (let turn = 0; turn < 50 && replaced.length === 0; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    assert.deepEqual(replaced, [[ROUTE]], 'a moved catalog must be announced to the surfaces that cache it')
    const models = await adapters[0].adapter.listModels(ROUTE)
    assert.deepEqual(
      models.map((model) => model.id),
      ['glm-5.3', 'kimi-k3'],
      'the listing is advertised, filtered by the same rules as any other',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
