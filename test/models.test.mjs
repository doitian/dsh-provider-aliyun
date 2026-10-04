/**
 * The membership filter is the one part of discovery that is a judgement rather
 * than an observation: an endpoint's listing carries no modality or task type,
 * so which ids a *chat* route may advertise is decided by patterns. These tests
 * pin the rules that keep that judgement from hiding something the user asked
 * for, and from failing a mount over a typo.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CHAT_MODEL_PATTERNS, FALLBACK_MODELS, NON_CHAT_MODEL_PATTERNS, ROUTE } from '../lib/catalog.js'
import { compilePatterns, materializeModels, mergeCatalog, selectIds } from '../lib/models.js'

const LISTING = [
  'qwen3.8-max',
  'qwen3-tts-flash',
  'qwen3.7-text-embedding',
  'glm-5.3',
  'deepseek-v4.1-flash',
  'kimi-k3',
  'qwen-image-3.0',
  'test-sre-gpu-auto-handle',
  'ZHIPU/GLM-5.3',
  'qwen3.7-flash-2026-07-15',
  'qwen3-omni-flash-realtime',
]

/** The shipped default filter, as the plugin builds it. */
const defaults = {
  mode: 'chat',
  include: compilePatterns([...CHAT_MODEL_PATTERNS]),
  exclude: compilePatterns([...NON_CHAT_MODEL_PATTERNS]),
  pinned: ['qwen3.8-max', 'deepseek-v4.1-flash', 'glm-5.3'],
}

test('the default filter keeps chat models and drops the rest of a workspace catalogue', () => {
  assert.deepEqual(selectIds(LISTING, defaults), [
    'qwen3.8-max',
    'glm-5.3',
    'deepseek-v4.1-flash',
    'kimi-k3',
  ])
})

test('a pinned id survives every pattern, including an exclusion', () => {
  const ids = selectIds(['qwen3.8-max', 'something-else'], {
    mode: 'chat',
    include: [],
    exclude: compilePatterns(['^qwen3\\.8-max$']),
    pinned: ['qwen3.8-max'],
  })
  assert.deepEqual(ids, ['qwen3.8-max'])
})

test('mode all takes the listing and applies only exclusions', () => {
  assert.deepEqual(selectIds(['glm-5.3', 'qwen-image-3.0', 'qwen3-omni-flash-realtime'], {
    mode: 'all',
    exclude: compilePatterns(['-realtime$']),
  }), ['glm-5.3', 'qwen-image-3.0'])
})

test('endpoint order is preserved, because it is the order the picker shows', () => {
  const ids = selectIds(['kimi-k3', 'glm-5.3', 'qwen3.8-max'], defaults)
  assert.deepEqual(ids, ['kimi-k3', 'glm-5.3', 'qwen3.8-max'])
})

test('an unusable pattern costs itself and nothing else', () => {
  const invalid = []
  const patterns = compilePatterns(['^glm-', '([unclosed', '^kimi-'], (source, error) => {
    invalid.push([source, error instanceof Error])
  })

  assert.equal(patterns.length, 2)
  assert.deepEqual(invalid, [['([unclosed', true]])
  assert.deepEqual(selectIds(['glm-5.3', 'kimi-k3', 'qwen3.8-max'], { mode: 'chat', include: patterns }), ['glm-5.3', 'kimi-k3'])
})

test('patterns are case-insensitive, because endpoints spell ids inconsistently', () => {
  const patterns = compilePatterns(['^minimax-m2\\.5$'])
  assert.deepEqual(selectIds(['MiniMax-M2.5'], { mode: 'chat', include: patterns }), ['MiniMax-M2.5'])
})

test('the metadata snapshot admits a model no pattern matches', () => {
  const ids = selectIds(['glm-5.3', 'qwen-image-3.0', 'registry-model'], {
    mode: 'chat',
    include: compilePatterns(['^glm-']),
    known: (id) => id === 'registry-model',
  })
  assert.deepEqual(ids, ['glm-5.3', 'registry-model'])
})

test('patterns mode is the tight one: the registry cannot widen it', () => {
  const ids = selectIds(['glm-5.3', 'registry-model'], {
    mode: 'patterns',
    include: compilePatterns(['^glm-']),
    known: () => true,
  })
  assert.deepEqual(ids, ['glm-5.3'])
})

test('an exclusion still beats the snapshot', () => {
  const ids = selectIds(['something-realtime', 'glm-5.3'], {
    mode: 'chat',
    include: compilePatterns(['^glm-']),
    exclude: compilePatterns(['-realtime$']),
    known: () => true,
  })
  assert.deepEqual(ids, ['glm-5.3'])
})

test('a model entry overrides the route switches for itself alone', () => {
  const route = { thinkingFormat: 'qwen', supportsReasoningEffort: false }
  const models = materializeModels({
    catalog: [
      { id: 'effort-model', name: 'Effort', contextWindow: 1, maxTokens: 1, input: ['text'], reasoning: true, compat: { supportsReasoningEffort: true } },
      { id: 'boolean-model', name: 'Boolean', contextWindow: 1, maxTokens: 1, input: ['text'], reasoning: true },
    ],
    provider: ROUTE,
    baseUrl: 'https://example.test/compatible-mode/v1',
    compat: route,
  })

  // The override wins for its own model and leaves the rest of the route's
  // switches intact; the model that names none keeps the route's exactly.
  assert.deepEqual(models[0].compat, { thinkingFormat: 'qwen', supportsReasoningEffort: true })
  assert.deepEqual(models[1].compat, route)
})

test('a discovered model keeps the route switches and the conservative levels', () => {
  const merged = mergeCatalog({
    ids: ['brand-new-model'],
    fallback: FALLBACK_MODELS,
    defaults: { contextWindow: 131_072, maxTokens: 32_768, input: ['text'] },
    metadata: {
      facts: () => ({ name: 'Brand New', contextWindow: 262_144, maxTokens: 65_536, input: ['text'], reasoning: true }),
    },
  })
  const route = { thinkingFormat: 'qwen', supportsReasoningEffort: false }
  const [model] = materializeModels({ catalog: merged, provider: ROUTE, baseUrl: 'x', compat: route })

  // Discovery states a model thinks, not how its endpoint spells an effort, so
  // an id nothing names keeps the boolean and the default level set.
  assert.deepEqual(model.compat, route)
  assert.deepEqual(model.thinkingLevelMap, { low: 'low', medium: 'medium', high: 'high' })
})

test('the shipped entries state what their endpoint accepts and withholds', () => {
  const byId = new Map(FALLBACK_MODELS.map((entry) => [entry.id, entry]))

  // Each verified model puts its level on the wire, and names the top levels
  // that pi-ai offers only when named.
  for (const id of ['qwen3.8-max', 'deepseek-v4.1-flash', 'glm-5.3']) {
    const entry = byId.get(id)
    assert.equal(entry.compat?.supportsReasoningEffort, true, `${id} must send its level as an effort`)
    assert.equal(entry.thinkingLevelMap.max, 'max', `${id} must name the max level its endpoint takes`)
  }

  // GLM-5.3 takes only low/high/max, so every other level is withheld rather
  // than left to pi-ai's "offer it unless nulled" default.
  const glm = byId.get('glm-5.3').thinkingLevelMap
  for (const level of ['off', 'minimal', 'medium', 'xhigh']) {
    assert.equal(glm[level], null, `glm-5.3 must withhold ${level}`)
  }
  assert.deepEqual(
    Object.entries(glm).filter(([, wire]) => typeof wire === 'string').map(([level]) => level),
    ['low', 'high', 'max'],
  )
})
