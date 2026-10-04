/**
 * The metadata snapshot is generated data, so it is checked rather than
 * reviewed: a regeneration that changed units, picked the wrong provider, or
 * dropped the models this package ships would otherwise reach a picker as wrong
 * capacities — the failure the whole filter exists to avoid.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { FALLBACK_MODELS } from '../lib/catalog.js'
import metadata from '../lib/metadata.json' with { type: 'json' }
import { createMetadataIndex, mergeCatalog } from '../lib/models.js'

/** Conservative defaults, as the configuration resolves them. */
const DEFAULTS = { contextWindow: 131_072, maxTokens: 32_768, input: ['text'] }

test('the snapshot records where it came from and is not empty', () => {
  assert.equal(metadata.source, 'https://models.dev/api.json')
  assert.ok(Array.isArray(metadata.providers) && metadata.providers.length > 0)
  assert.ok(Number.isFinite(Date.parse(metadata.generatedAt)), 'generatedAt must be a date')
  assert.ok(Object.keys(metadata.models).length > 0)
})

test('every entry states facts the adapter can dispatch', () => {
  for (const [id, facts] of Object.entries(metadata.models)) {
    assert.equal(typeof facts.name === 'string' && facts.name.length > 0, true, `${id}: display name`)
    assert.ok(Number.isInteger(facts.contextWindow) && facts.contextWindow > 0, `${id}: contextWindow`)
    assert.ok(Number.isInteger(facts.maxTokens) && facts.maxTokens > 0, `${id}: maxTokens`)
    assert.ok(Array.isArray(facts.input) && facts.input.length > 0, `${id}: input`)
    for (const modality of facts.input) {
      assert.ok(['text', 'image'].includes(modality), `${id}: "${modality}" is not a modality this package states`)
    }
    assert.equal(typeof facts.reasoning, 'boolean', `${id}: reasoning`)
  }
})

test('the snapshot agrees with the shipped catalog on the models it names', () => {
  for (const entry of FALLBACK_MODELS) {
    const facts = metadata.models[entry.id]
    assert.ok(facts !== undefined, `${entry.id} is shipped but missing from the snapshot`)
    // Two independent sources agreeing is the point of shipping both; a
    // divergence after a regeneration is a human decision, not a silent update.
    assert.equal(facts.contextWindow, entry.contextWindow, `${entry.id}: contextWindow`)
    assert.equal(facts.maxTokens, entry.maxTokens, `${entry.id}: maxTokens`)
  }
})

test('lookup bridges the spellings the two sides use', () => {
  const index = createMetadataIndex(metadata)

  const dashed = index.facts('qwen2-5-32b-instruct')
  assert.ok(dashed !== undefined, 'the registry spelling resolves')
  assert.deepEqual(index.facts('qwen2.5-32b-instruct'), dashed, 'the endpoint spelling resolves to the same facts')
  assert.deepEqual(index.facts('Qwen2-5-32B-Instruct'), dashed, 'case is ignored')

  // A vendor-prefixed alias the endpoint lists beside the canonical id: worth
  // facts, but not worth admitting twice into a picker.
  assert.deepEqual(index.facts('vanchin/deepseek-v4.1-flash'), index.facts('deepseek-v4.1-flash'))
  assert.equal(index.knows('vanchin/deepseek-v4.1-flash'), false)
  assert.equal(index.knows('deepseek-v4.1-flash'), true)

  assert.equal(index.facts('test-sre-gpu-auto-handle'), undefined, 'an unlisted id has no facts')
})

test('the index ignores a malformed snapshot instead of throwing', () => {
  const index = createMetadataIndex(undefined)
  assert.equal(index.size, 0)
  assert.equal(index.facts('glm-5.3'), undefined)
})

test('snapshot facts fill a discovered model, and the catalog outranks them', () => {
  const facts = {
    'known-model': { name: 'Known Model', contextWindow: 262_144, maxTokens: 65_536, input: ['text', 'image'], reasoning: true },
  }
  const metadata = { facts: (id) => facts[id] }
  const merged = mergeCatalog({
    ids: ['known-model', 'mystery-model', 'glm-5.3'],
    fallback: FALLBACK_MODELS,
    defaults: DEFAULTS,
    metadata,
  })

  assert.deepEqual(merged[0], {
    id: 'known-model',
    name: 'Known Model',
    contextWindow: 262_144,
    maxTokens: 65_536,
    input: ['text', 'image'],
    reasoning: true,
    thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
  })
  assert.equal(merged[1].contextWindow, DEFAULTS.contextWindow)
  assert.equal(merged[1].reasoning, false)
  // The shipped entry is hand-verified, so it is used as written.
  assert.equal(merged[2], FALLBACK_MODELS.find((entry) => entry.id === 'glm-5.3'))
})

test('unusable snapshot numbers fall back instead of producing a broken model', () => {
  const merged = mergeCatalog({
    ids: ['odd-model'],
    fallback: [],
    defaults: DEFAULTS,
    metadata: { facts: () => ({ name: 'Odd', contextWindow: 0, maxTokens: -1, input: [], reasoning: 'yes' }) },
  })

  assert.equal(merged[0].contextWindow, DEFAULTS.contextWindow)
  assert.equal(merged[0].maxTokens, DEFAULTS.maxTokens)
  assert.deepEqual(merged[0].input, ['text'])
  assert.equal(merged[0].reasoning, false)
})
