/**
 * The configuration is editable while the plugin is mounted.
 *
 * This is the property the Models page depends on and the reason the schema
 * marks its editable nodes `.volatile()`: the settings service writes the stored
 * user layer into those references *in place*, so the plugin is not remounted and
 * every derived value — the endpoint discovery talks to, the row's display name,
 * the advertised catalog — has to be re-derived by the plugin itself.
 *
 * The cells below stand in for schemastery's volatile references. The plugin
 * only ever reads one through `.get()`, which is the whole of the protocol it
 * uses, so a cell is a faithful stub and the test needs no harness runtime.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CHAT_MODEL_PATTERNS,
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  FALLBACK_MODELS,
  NON_CHAT_MODEL_PATTERNS,
  ROUTE,
} from '../lib/catalog.js'
import { Config, apply, liveConfig } from '../lib/index.js'

const DEFAULTS = { contextWindow: 131_072, maxTokens: 32_768, input: ['text'] }

/** A volatile reference, as `lib/index.js` reads one. */
function cell(initial) {
  let value = initial
  return {
    get: () => value,
    /** Standing in for a settings write, which updates the reference in place. */
    write: (next) => {
      value = next
    },
  }
}

/** Let pending promise chains and timers settle. */
async function flush(rounds = 6) {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setTimeout(resolve, 5))
}

/**
 * Mount the plugin over a cell-backed configuration.
 *
 * @param {object} [overrides] - initial field values.
 * @returns the cells, the recorded host calls, and the mount.
 */
function mounted(overrides = {}) {
  const cells = {
    displayName: cell(overrides.displayName ?? 'Aliyun DashScope'),
    apiKeyEnv: cell(overrides.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL: cell(overrides.baseURL ?? DEFAULT_BASE_URL),
    models: cell(overrides.models ?? FALLBACK_MODELS),
    reasoning: cell(undefined),
    headers: cell(undefined),
    discovery: cell({
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
      ...(overrides.discovery ?? {}),
    }),
  }

  const fetches = []
  const announced = []
  const rows = []
  const listeners = []
  const adapters = []
  const presentations = []

  const ctx = {
    fiber: { entry: { options: { id: 'llm-aliyun' } } },
    llm: {
      registerAdapter: (routes, adapter) => {
        adapters.push({ routes, adapter })
        return {
          replace: (next) => announced.push(next),
        }
      },
      registerConfigurableProviders: (entries) => {
        rows.push(entries)
        return {
          replace: (next) => rows.push(next),
        }
      },
      registerModelDiscovery: () => () => {},
    },
    inject: (names, callback) => {
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
      listeners.push({ event, listener })
    },
    get: (name) => (name === 'credentials' ? { resolve: async () => ({ value: 'sk-test' }) } : undefined),
    logger: { warn() {}, debug() {} },
  }

  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    fetches.push(String(url))
    return new Response(
      JSON.stringify({ object: 'list', data: [{ id: 'glm-5.3' }, { id: 'qwen3-tts-flash' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }

  apply(ctx, cells)

  return {
    cells,
    fetches,
    announced,
    rows,
    listeners,
    adapters,
    presentations,
    restore: () => {
      globalThis.fetch = originalFetch
    },
    /** Deliver the event a settings write publishes on the Host. */
    announceSettings: (ns = 'llm-aliyun') => {
      for (const listener of listeners) if (listener.event === 'settings/document-updated') listener.listener(ns, 1)
    },
  }
}

test('a settings write moves the endpoint the plugin talks to, without remounting', async () => {
  const mount = mounted()
  try {
    await flush()
    assert.equal(mount.adapters.length, 1, 'the plugin mounts exactly one adapter')
    assert.ok(
      mount.fetches.some((url) => url.startsWith(`${DEFAULT_BASE_URL}/models`)),
      'the mount-time listing reads the configured endpoint',
    )

    const before = mount.fetches.length
    mount.cells.baseURL.write('https://moved.example/v1')
    mount.announceSettings()
    await flush()

    assert.ok(
      mount.fetches.slice(before).some((url) => url.startsWith('https://moved.example/v1/models')),
      'a moved endpoint is what the next listing reads',
    )
    // A remount would have registered a second adapter; the point of a volatile
    // field is that this does not happen.
    assert.equal(mount.adapters.length, 1, 'a settings write must not remount the plugin')
  } finally {
    mount.restore()
  }
})

test('no settings write means no second listing and no re-announcement', async () => {
  const mount = mounted()
  try {
    await flush()
    const fetches = mount.fetches.length
    const announcements = mount.announced.length
    // Every adapter read notices whether the configuration moved.
    await mount.adapters[0].adapter.listModels(ROUTE)
    await mount.adapters[0].adapter.resolveModel(ROUTE, 'glm-5.3')
    await flush()
    assert.equal(mount.fetches.length, fetches, 'an unchanged configuration must not re-interrogate the endpoint')
    assert.equal(mount.announced.length, announcements, 'an unchanged catalog must not be re-announced')
  } finally {
    mount.restore()
  }
})

test('a moved display name replaces the row rather than adding one', async () => {
  const mount = mounted()
  try {
    await flush()
    assert.equal(mount.rows.length, 1)
    assert.equal(mount.rows[0][0].displayName, 'Aliyun DashScope')

    mount.cells.displayName.write('My Aliyun')
    mount.announceSettings()

    assert.equal(mount.rows.length, 2, 'the row is replaced, not duplicated')
    assert.equal(mount.rows[1][0].displayName, 'My Aliyun')
    assert.equal(mount.rows[1][0].provider, ROUTE)
    assert.equal(mount.rows[1][0].settingsNs, 'llm-aliyun')
  } finally {
    mount.restore()
  }
})

test('a pinned catalog replaces what the route advertises, and is announced', async () => {
  const mount = mounted()
  try {
    await flush()
    const announcements = mount.announced.length
    mount.cells.models.write([
      { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000, maxTokens: 100, input: ['text'], reasoning: false },
    ])
    mount.announceSettings()

    assert.ok(mount.announced.length > announcements, 'a moved catalog must be announced to the surfaces that cache it')
    assert.deepEqual(mount.announced.at(-1), [ROUTE])
  } finally {
    mount.restore()
  }
})

test('an unrelated settings namespace does not move this plugin', async () => {
  const mount = mounted()
  try {
    await flush()
    const rows = mount.rows.length
    const fetches = mount.fetches.length
    mount.announceSettings('llm-pi-ai')
    await flush()
    assert.equal(mount.rows.length, rows)
    assert.equal(mount.fetches.length, fetches)
  } finally {
    mount.restore()
  }
})

test('the settings service is told this plugin ships its own page', async () => {
  const mount = mounted()
  try {
    assert.deepEqual(mount.presentations.map((entry) => entry.policy), [{ auto: false }])
  } finally {
    mount.restore()
  }
})
