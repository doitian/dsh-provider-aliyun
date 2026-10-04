#!/usr/bin/env node
/**
 * Generate the model-metadata snapshot this package ships.
 *
 * The endpoint answers *which* models exist and nothing else — its listing
 * carries `id`, `object`, `created`, `owned_by` — while the harness trusts
 * `contextWindow` when it decides to compact history and needs to know which
 * models accept images. `models.dev` publishes both for Alibaba's models, so
 * this script turns that registry into `lib/metadata.json`: a build-time
 * snapshot, committed here, with no runtime dependency on a third party.
 *
 * Membership still comes from the endpoint at run time. The snapshot only
 * answers two questions about an id the endpoint listed — "is this a chat
 * model?" and "what are its facts?" — and a model newer than the snapshot is
 * still advertised when a pattern matches it, with conservative defaults.
 *
 *   npm run generate:metadata
 *
 * Re-run it when models.dev learns about models this route should know.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = 'https://models.dev/api.json'

/**
 * Registries to merge, most specific first. `alibaba-cn` is the product this
 * plugin's workspace endpoints belong to; `alibaba` only adds ids the China
 * registry has not listed, and never overrides one it has.
 */
const PROVIDERS = ['alibaba-cn', 'alibaba']

/** Input modalities this package can express; everything else is dropped. */
const MODALITIES = ['text', 'image']

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'lib', 'metadata.json')

const positive = (value) => (Number.isInteger(value) && value > 0 ? value : undefined)
const text = (value) => (typeof value === 'string' && value.length > 0 ? value : undefined)

/** One registry entry as this package states model facts. */
function factsOf(entry) {
  const id = text(entry?.id)
  const contextWindow = positive(entry?.limit?.context)
  const maxTokens = positive(entry?.limit?.output)
  const output = Array.isArray(entry?.modalities?.output) ? entry.modalities.output : []
  const inputs = Array.isArray(entry?.modalities?.input) ? entry.modalities.input : []
  // Two capability facts decide whether this is a *chat* model: it must read
  // text (a transcription model answers text but cannot be asked a question) and
  // it must answer with text (image and speech generators cannot).
  if (id === undefined || contextWindow === undefined || maxTokens === undefined) return undefined
  if (!output.includes('text') || !inputs.includes('text')) return undefined
  return {
    name: text(entry?.name) ?? id,
    contextWindow,
    maxTokens,
    // `text` is always present on a chat route; `image` only when published,
    // because a listing and a registry both stay silent about the rest.
    input: ['text', ...MODALITIES.filter((modality) => modality !== 'text' && inputs.includes(modality))],
    reasoning: entry?.reasoning === true,
  }
}

const response = await fetch(SOURCE)
if (!response.ok) {
  console.error(`generate-metadata: ${SOURCE} answered ${response.status}`)
  process.exit(1)
}
const registry = await response.json()

const models = {}
const counts = {}
for (const provider of PROVIDERS) {
  const entries = registry?.[provider]?.models
  if (entries === null || typeof entries !== 'object') {
    console.error(`generate-metadata: ${SOURCE} has no provider "${provider}"`)
    process.exit(1)
  }
  let added = 0
  // Sorted so a regeneration diffs as the registry changed, not as it iterated.
  for (const id of Object.keys(entries).sort()) {
    if (id in models) continue
    const facts = factsOf(entries[id])
    if (facts === undefined) continue
    models[id] = facts
    added++
  }
  counts[provider] = added
}

const snapshot = {
  // Provenance, so a reader knows where these numbers came from and how old
  // they are without reading this script.
  source: SOURCE,
  providers: PROVIDERS,
  generatedAt: new Date().toISOString(),
  models: Object.fromEntries(Object.entries(models).sort(([left], [right]) => left.localeCompare(right))),
}

writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`)

console.log(`generate-metadata: ${Object.keys(models).length} models -> lib/metadata.json`)
for (const [provider, count] of Object.entries(counts)) console.log(`  ${provider}: ${count} added`)
const withImage = Object.values(models).filter((facts) => facts.input.includes('image')).length
const reasoning = Object.values(models).filter((facts) => facts.reasoning).length
console.log(`  ${withImage} accept images, ${reasoning} can think`)
