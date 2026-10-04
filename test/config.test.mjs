/**
 * The configuration schema is the profile's contract, and two of its defaults
 * are load-bearing in a way a reader cannot see:
 *
 * - `discovery` is a nested object, so a schema that failed to resolve the
 *   block's own defaults would hand `apply()` an `undefined` `enabled` — which
 *   reads as *off*, silently disabling the feature this package exists for.
 * - `models` must default to the shipped fallback, so an empty config still
 *   mounts a route with something to select.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DISCOVERY_TTL_MS,
  DISCOVERY_WAIT_MS,
  FALLBACK_MODELS,
} from '../lib/catalog.js'
import { DEFAULT_DISCOVERY_TIMEOUT_MS } from '../lib/discovery.js'
import { Config } from '../lib/index.js'

test('an empty config mounts a working, discovering route', () => {
  const config = Config({})

  assert.equal(config.displayName, 'Aliyun DashScope')
  assert.equal(config.apiKeyEnv, DEFAULT_API_KEY_ENV)
  assert.equal(config.baseURL, DEFAULT_BASE_URL)
  assert.deepEqual(config.models.map((entry) => entry.id), FALLBACK_MODELS.map((entry) => entry.id))

  assert.equal(config.discovery.enabled, true)
  assert.equal(config.discovery.ttlMs, DISCOVERY_TTL_MS)
  assert.equal(config.discovery.waitMs, DISCOVERY_WAIT_MS)
  assert.equal(config.discovery.timeoutMs, DEFAULT_DISCOVERY_TIMEOUT_MS)
  assert.equal(config.discovery.contextWindow, 131_072)
  assert.equal(config.discovery.maxTokens, 32_768)
  assert.deepEqual([...config.discovery.input], ['text'])
})

test('one discovery knob does not disturb the others', () => {
  const config = Config({ discovery: { enabled: false } })

  assert.equal(config.discovery.enabled, false)
  assert.equal(config.discovery.ttlMs, DISCOVERY_TTL_MS)
  assert.equal(config.discovery.waitMs, DISCOVERY_WAIT_MS)
})

test('a profile can pin the whole catalog itself', () => {
  const config = Config({
    models: [{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000, maxTokens: 100, input: ['text'], reasoning: false }],
  })

  assert.deepEqual(config.models.map((entry) => entry.id), ['glm-5.3'])
  assert.equal(config.discovery.enabled, true)
})
