/**
 * The configuration schema is the profile's contract, and three of its
 * properties are load-bearing in a way a reader cannot see:
 *
 * - `discovery` is a nested object, so a schema that failed to resolve the
 *   block's own defaults would hand `apply()` an `undefined` `enabled` — which
 *   reads as *off*, silently disabling the feature this package exists for.
 * - `models` must default to the shipped fallback, so an empty config still
 *   mounts a route with something to select.
 * - The editable fields must be `.volatile()`. That is not a style choice: the
 *   settings service refuses to write a field that is not volatile, so dropping
 *   the mark silently removes this plugin's row from the Models page while every
 *   other test here still passes.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CHAT_MODEL_PATTERNS,
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DISCOVERY_TTL_MS,
  DISCOVERY_WAIT_MS,
  FALLBACK_MODELS,
  NON_CHAT_MODEL_PATTERNS,
} from '../lib/catalog.js'
import { DEFAULT_DISCOVERY_TIMEOUT_MS } from '../lib/discovery.js'
import { Config, liveConfig } from '../lib/index.js'

/** Fields the Models page card edits, and the nodes that make them writable. */
const VOLATILE_FIELDS = ['displayName', 'apiKeyEnv', 'baseURL', 'models', 'reasoning', 'headers', 'discovery']

test('every field the Models page edits is volatile', () => {
  const config = Config({})
  for (const field of VOLATILE_FIELDS) {
    assert.equal(
      typeof config[field]?.get,
      'function',
      `${field} must be volatile, or the settings service refuses to write it`,
    )
  }
})

test('an empty config mounts a working, discovering route', () => {
  const config = liveConfig(Config({}))

  assert.equal(config.displayName, 'Aliyun DashScope')
  assert.equal(config.apiKeyEnv, DEFAULT_API_KEY_ENV)
  assert.equal(config.baseURL, DEFAULT_BASE_URL)
  assert.deepEqual(config.models.map((entry) => entry.id), FALLBACK_MODELS.map((entry) => entry.id))

  assert.equal(config.discovery.enabled, true)
  assert.equal(config.discovery.filter, 'chat')
  assert.deepEqual([...config.discovery.include], [...CHAT_MODEL_PATTERNS])
  assert.deepEqual([...config.discovery.exclude], [...NON_CHAT_MODEL_PATTERNS])
  assert.equal(config.discovery.ttlMs, DISCOVERY_TTL_MS)
  assert.equal(config.discovery.waitMs, DISCOVERY_WAIT_MS)
  assert.equal(config.discovery.timeoutMs, DEFAULT_DISCOVERY_TIMEOUT_MS)
  assert.equal(config.discovery.contextWindow, 131_072)
  assert.equal(config.discovery.maxTokens, 32_768)
  assert.deepEqual([...config.discovery.input], ['text'])
})

test('one discovery knob does not disturb the others', () => {
  const config = liveConfig(Config({ discovery: { enabled: false } }))

  assert.equal(config.discovery.enabled, false)
  assert.equal(config.discovery.ttlMs, DISCOVERY_TTL_MS)
  assert.equal(config.discovery.waitMs, DISCOVERY_WAIT_MS)
})

test('a profile can pin the whole catalog itself', () => {
  const config = liveConfig(Config({
    models: [{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000, maxTokens: 100, input: ['text'], reasoning: false }],
  }))

  assert.deepEqual(config.models.map((entry) => entry.id), ['glm-5.3'])
  assert.equal(config.discovery.enabled, true)
})

test('liveConfig reads a plain config exactly as it reads volatile references', () => {
  // `plainConfig` in the settings service hands the surface an already-unwrapped
  // config, and the tests hand `apply` a hand-built one, so both shapes have to
  // read the same way.
  const plain = { displayName: 'Plain', apiKeyEnv: 'REF', baseURL: 'https://plain.example/v1', models: [] }
  assert.deepEqual(liveConfig(plain).baseURL, 'https://plain.example/v1')
  assert.deepEqual(liveConfig(plain).displayName, 'Plain')
  // Absent nodes fall back to the schema's own defaults rather than throwing.
  assert.equal(liveConfig(plain).discovery.filter, 'chat')
  assert.equal(liveConfig(plain).discovery.maxTokens, 32_768)
})
