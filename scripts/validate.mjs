#!/usr/bin/env node
/**
 * Static validation for this provider bundle.
 *
 * It checks the two things that fail silently in a profile and loudly only at
 * runtime: the manifest-to-patch wiring (a tarball that drops the patch, or a
 * patch that names the wrong package), and the shipped catalog's integrity
 * (a duplicate id, a non-integer capacity, or a level map pi-ai would read as
 * "offers nothing").
 *
 * It does not replace the harness: `test/adapter.test.mjs` drives the real
 * adapter, and the harness validates configuration when the profile composes.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import yaml from 'js-yaml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const MODALITIES = ['text', 'image']

const problems = []
const fail = (message) => problems.push(message)

const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'))
const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0

/** Confirm the manifest publishes what the bundle needs, and names its peers. */
function checkManifest(manifest) {
  const patchPath = manifest?.dsh?.bundle?.patch
  if (typeof patchPath !== 'string' || patchPath.length === 0) {
    fail('package.json: "dsh.bundle.patch" must name the bundle patch file')
    return undefined
  }
  const relative = patchPath.replace(/^\.\//, '')
  const files = manifest.files ?? []
  if (!files.includes(relative)) {
    fail(`package.json: "files" must include "${relative}", or npm drops it from the tarball`)
  }
  const main = manifest.main
  if (typeof main !== 'string') {
    fail('package.json: "main" is required so the package resolves as a plugin module')
  } else if (!files.includes(main.replace(/^\.\//, ''))) {
    fail(`package.json: "files" must include the "main" module "${main}"`)
  }
  if (manifest.publishConfig?.access !== 'public') {
    fail('package.json: "publishConfig.access" must be "public" for a scoped package')
  }
  if (!existsSync(join(root, relative))) fail(`package.json: "${relative}" does not exist`)

  // Every listed file must exist, and the module graph must be inside "files" —
  // an unlisted import publishes a package that cannot load.
  for (const entry of files) {
    if (!existsSync(join(root, entry))) fail(`package.json: "files" names "${entry}", which does not exist`)
  }
  for (const needed of ['lib/adapter.js', 'lib/catalog.js', 'lib/discovery.js', 'lib/models.js', 'lib/provider.js']) {
    if (!files.includes(needed)) fail(`package.json: "files" must include "${needed}" (imported by the plugin)`)
  }

  // The plugin imports these at runtime, so they must be declared.
  for (const peer of [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-llm-pi-ai',
    '@deepseek-ai/schemastery',
  ]) {
    if (!(peer in (manifest.peerDependencies ?? {}))) {
      fail(`package.json: "${peer}" must be declared in "peerDependencies"`)
    }
  }
  if (!('@earendil-works/pi-ai' in (manifest.dependencies ?? {}))) {
    fail('package.json: "@earendil-works/pi-ai" must be declared in "dependencies"')
  }
  return relative
}

/** Confirm the patch inserts this package, and nothing else. */
function checkPatch(relative, manifest) {
  let patch
  try {
    patch = yaml.load(readFileSync(join(root, relative), 'utf8'))
  } catch (error) {
    return fail(`${relative}: not valid YAML — ${error.message}`)
  }
  if (!Array.isArray(patch)) {
    return fail(`${relative}: a profile patch is a top-level YAML array of entries`)
  }
  const inserts = patch.flatMap((layer) => (isPlainObject(layer) && Array.isArray(layer.insert) ? layer.insert : []))
  if (inserts.length !== 1) {
    return fail(`${relative}: expected exactly one inserted entry, found ${inserts.length}`)
  }
  const [entry] = inserts
  if (entry.name !== manifest.name) {
    fail(`${relative}: the inserted entry must name this package ("${manifest.name}"), found ${JSON.stringify(entry.name)}`)
  }
  if (typeof entry.id !== 'string' || entry.id.length === 0) {
    fail(`${relative}: the inserted entry needs a non-empty id (it becomes the settings namespace)`)
  }
}

/** Confirm every shipped model is one the adapter can dispatch. */
function checkCatalog(catalog) {
  if (!Array.isArray(catalog) || catalog.length === 0) {
    return fail('lib/catalog.js: FALLBACK_MODELS must be a non-empty array')
  }
  const seen = new Set()
  for (const entry of catalog) {
    const at = 'lib/catalog.js'
    if (!isPlainObject(entry)) return fail(`${at}: every entry must be an object`)
    const id = entry.id
    if (typeof id !== 'string' || id.length === 0) {
      fail(`${at}: a model has an empty id`)
      continue
    }
    if (seen.has(id)) fail(`${at}: model "${id}" is listed more than once`)
    seen.add(id)
    if (typeof entry.name !== 'string' || entry.name.length === 0) {
      fail(`${at}: "${id}" needs a display name`)
    }
    for (const field of ['contextWindow', 'maxTokens']) {
      if (!isPositiveInteger(entry[field])) fail(`${at}: "${id}" ${field} must be a positive integer`)
    }
    if (!Array.isArray(entry.input) || entry.input.length === 0) {
      fail(`${at}: "${id}" input must be a non-empty list`)
    } else {
      for (const modality of entry.input) {
        if (!MODALITIES.includes(modality)) fail(`${at}: "${id}" input names "${modality}", which is not a modality`)
      }
    }
    if (typeof entry.reasoning !== 'boolean') fail(`${at}: "${id}" reasoning must be a boolean`)
    if (entry.reasoning === false && entry.thinkingLevelMap !== undefined) {
      fail(`${at}: "${id}" is non-reasoning but declares thinkingLevelMap`)
    }
    if (entry.thinkingLevelMap !== undefined) {
      if (!isPlainObject(entry.thinkingLevelMap)) {
        fail(`${at}: "${id}" thinkingLevelMap must be an object`)
        continue
      }
      let offered = 0
      for (const [level, wire] of Object.entries(entry.thinkingLevelMap)) {
        if (!THINKING_LEVELS.includes(level)) {
          fail(`${at}: "${id}" thinkingLevelMap."${level}" is not a thinking level`)
          continue
        }
        if (wire === null) {
          if (level !== 'off') fail(`${at}: "${id}" thinkingLevelMap.${level} needs a wire value; only "off" may be null`)
        } else if (typeof wire !== 'string' || wire.length === 0) {
          fail(`${at}: "${id}" thinkingLevelMap.${level} must be a non-empty string`)
        } else if (level !== 'off') {
          offered++
        }
      }
      if (offered === 0) {
        fail(`${at}: "${id}" thinkingLevelMap offers no level beyond "off"`)
      }
    }
  }
}

/**
 * Confirm the capacities discovery hands an unknown id are usable.
 *
 * These are the values an endpoint-discovered model nobody listed gets, so a
 * zero, a fraction, or an empty modality list would produce a model the adapter
 * cannot dispatch — silently, because no catalog entry states it.
 */
function checkDiscoveryDefaults(defaults) {
  const at = 'lib/catalog.js: DISCOVERY_DEFAULTS'
  if (!isPlainObject(defaults)) return fail(`${at} must be an object`)
  for (const field of ['contextWindow', 'maxTokens']) {
    if (!isPositiveInteger(defaults[field])) fail(`${at}.${field} must be a positive integer`)
  }
  if (!Array.isArray(defaults.input) || defaults.input.length === 0) {
    fail(`${at}.input must be a non-empty list`)
  } else {
    for (const modality of defaults.input) {
      if (!MODALITIES.includes(modality)) fail(`${at}.input names "${modality}", which is not a modality`)
    }
  }
}

/**
 * Confirm the default membership filter compiles and recognizes this package's
 * own catalog.
 *
 * A pattern that does not compile is skipped at runtime with a warning, so a
 * typo would quietly widen or narrow what every deployment advertises. And a
 * shipped model the default filter would not match means the package's own
 * shortlist and its own default disagree — the kind of thing that only shows up
 * as a model missing from someone's picker.
 */
function checkPatterns(include, exclude, catalog) {
  const at = 'lib/catalog.js'
  const compiled = []
  for (const [name, sources] of [['CHAT_MODEL_PATTERNS', include], ['NON_CHAT_MODEL_PATTERNS', exclude]]) {
    if (!Array.isArray(sources) || sources.length === 0) {
      fail(`${at}: ${name} must be a non-empty list of regular expressions`)
      continue
    }
    for (const source of sources) {
      if (typeof source !== 'string' || source.length === 0) {
        fail(`${at}: ${name} has an empty pattern`)
        continue
      }
      try {
        const pattern = new RegExp(source, 'i')
        if (name === 'CHAT_MODEL_PATTERNS') compiled.push(pattern)
      } catch (error) {
        fail(`${at}: ${name} pattern ${JSON.stringify(source)} is not a valid regular expression — ${error.message}`)
      }
    }
  }
  for (const entry of catalog) {
    if (!compiled.some((pattern) => pattern.test(entry.id))) {
      fail(`${at}: shipped model "${entry.id}" matches no CHAT_MODEL_PATTERNS entry, so the default filter would not advertise it`)
    }
  }
}

async function main() {
  const manifest = readJson('package.json')
  const patchRelative = checkManifest(manifest)
  if (patchRelative) checkPatch(patchRelative, manifest)

  const {
    CHAT_MODEL_PATTERNS,
    DISCOVERY_DEFAULTS,
    FALLBACK_MODELS,
    NON_CHAT_MODEL_PATTERNS,
  } = await import('../lib/catalog.js')
  checkCatalog(FALLBACK_MODELS)
  checkDiscoveryDefaults(DISCOVERY_DEFAULTS)
  checkPatterns(CHAT_MODEL_PATTERNS, NON_CHAT_MODEL_PATTERNS, FALLBACK_MODELS)

  if (problems.length > 0) {
    console.error(`validate: ${problems.length} problem(s)`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log('validate: ok')
  console.log(`  package: ${manifest.name}@${manifest.version}`)
  console.log(`  patch:   ${patchRelative}`)
  console.log(`  models:  ${FALLBACK_MODELS.length} fallback (${FALLBACK_MODELS.map((m) => m.id).join(', ')})`)
  console.log(`  filter:  ${CHAT_MODEL_PATTERNS.length} include / ${NON_CHAT_MODEL_PATTERNS.length} exclude patterns`)
}

main().catch((error) => {
  console.error(`validate: ${error.message}`)
  process.exit(1)
})
