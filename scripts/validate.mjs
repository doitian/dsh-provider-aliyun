#!/usr/bin/env node
/**
 * Static validation for this provider bundle.
 *
 * It checks the things that fail silently in a profile and loudly only at
 * runtime: the manifest-to-patch wiring (a tarball that drops the patch, or a
 * patch that names the wrong package), the shipped catalog's integrity (a
 * duplicate id, a non-integer capacity, or a level map pi-ai would read as
 * "offers nothing"), and the browser half (a bundle that registers nothing, or
 * under the wrong module id, blanks the Models page row with no server-side
 * symptom at all).
 *
 * It does not replace the harness: `test/adapter.test.mjs` drives the real
 * adapter, `test/live-config.test.mjs` drives the mount, and the harness
 * validates configuration when the profile composes.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

import yaml from 'js-yaml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const MODALITIES = ['text', 'image']

/**
 * Modules the browser's frozen platform table already answers.
 *
 * A bundle outside the harness repository is expected to write its own controls
 * rather than import harness client packages, which change shape without notice
 * and blank the slot entry when one throws. Reading React from the table is the
 * one exception, and it is required.
 */
const CLIENT_BASELINE_MODULES = ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/cordis']

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
  for (const needed of ['lib/adapter.js', 'lib/catalog.js', 'lib/client.js', 'lib/discovery.js', 'lib/metadata.json', 'lib/models.js', 'lib/provider.js']) {
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

/**
 * Confirm the manifest declares a browser half the client module system accepts.
 *
 * `dsh.client` is what makes the host compose a bundle row at all, and the
 * composition refuses a declaration without a `./client` export — so a missing
 * export is a plugin that mounts on the host and silently never appears in the
 * page.
 *
 * @param {object} manifest - the package manifest.
 * @returns {string | undefined} the client bundle path, relative to the root.
 */
function checkClientManifest(manifest) {
  const decl = manifest?.dsh?.client
  if (!isPlainObject(decl)) {
    return fail('package.json: "dsh.client" must declare the browser half, or this plugin has no Models-page card')
  }
  if (decl.platform !== 'web') {
    fail(`package.json: "dsh.client.platform" must be "web", found ${JSON.stringify(decl.platform)}`)
  }
  if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') {
    fail('package.json: "dsh.client.immediately" must be a boolean when present')
  }
  for (const [field, value] of [['inject', decl.inject], ['external', decl.external]]) {
    if (value === undefined) continue
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
      fail(`package.json: "dsh.client.${field}" must be a list of package names`)
    } else if (value.includes(manifest.name)) {
      fail(`package.json: "dsh.client.${field}" must not name this package, which answers itself`)
    }
  }
  const target = manifest.exports?.['./client']
  if (typeof target !== 'string' || target.length === 0) {
    fail('package.json: "exports" must map "./client" to the browser bundle, or the client module system refuses the declaration')
    return undefined
  }
  const relative = target.replace(/^\.\//, '')
  if (!(manifest.files ?? []).includes(relative)) {
    fail(`package.json: "files" must include "${relative}", or npm drops the browser half from the tarball`)
  }
  if (!existsSync(join(root, relative))) {
    fail(`package.json: "exports[\'./client\']" names "${relative}", which does not exist`)
    return undefined
  }
  return relative
}

/**
 * Load the browser bundle in a stub module system and check what it registered.
 *
 * The bundle cannot be built or type-checked here — it is written by hand in the
 * loader's own format — so the useful check is behavioural: it registers exactly
 * one factory, under this package's name, and that factory materializes into the
 * `apply`/`inject` pair the client plugin table expects. A bundle that fails any
 * of those blanks the row in the browser and reports nothing on the host.
 *
 * @param {object} manifest - the package manifest.
 * @param {string} relative - the client bundle path.
 */
function checkClientBundle(manifest, relative) {
  const at = relative
  const source = readFileSync(join(root, relative), 'utf8')
  const registrations = []
  const requested = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (registration) => registrations.push(registration),
      },
    },
    console,
    // `typeof document` is the bundle's own guard for a headless materialization.
    document: undefined,
  }
  try {
    runInNewContext(source, sandbox, { filename: relative })
  } catch (error) {
    return fail(`${at}: registering the bundle threw — ${error.message}`)
  }

  if (registrations.length !== 1) {
    return fail(`${at}: expected exactly one window.__ModuleLoader__.load() call, found ${registrations.length}`)
  }
  const [registration] = registrations
  if (registration.id !== manifest.name) {
    fail(`${at}: the bundle must register under the package name ("${manifest.name}"), found ${JSON.stringify(registration.id)}`)
  }
  if (typeof registration.factory !== 'function') {
    fail(`${at}: the registration needs a "factory" function`)
    return
  }

  // The factory is the module: materializing it must yield the plugin's exports
  // without touching anything it did not declare a request for.
  let exports
  try {
    exports = registration.factory((specifier) => {
      requested.push(specifier)
      if (!CLIENT_BASELINE_MODULES.includes(specifier)) {
        throw new Error(`the browser module table cannot answer "${specifier}"`)
      }
      return {}
    })
  } catch (error) {
    return fail(`${at}: materializing the bundle threw — ${error.message}`)
  }
  if (!isPlainObject(exports)) return fail(`${at}: the factory must return the plugin's exports object`)
  if (typeof exports.apply !== 'function') fail(`${at}: the client plugin must export "apply"`)
  if (!Array.isArray(exports.inject) || exports.inject.length === 0) {
    fail(`${at}: the client plugin must export a non-empty "inject" list`)
  } else {
    for (const service of exports.inject) {
      if (typeof service !== 'string' || service.length === 0) fail(`${at}: "inject" must name client services`)
    }
  }
  for (const specifier of new Set(requested)) {
    if (!CLIENT_BASELINE_MODULES.includes(specifier)) {
      fail(`${at}: requires "${specifier}" at module scope; a plugin outside the harness ships its own controls and takes only the module table's baseline`)
    }
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

/**
 * Confirm the generated metadata snapshot carries usable facts.
 *
 * It is generated data, so the shape is what can be checked here — a unit
 * change or a wrong provider would reach a picker as wrong capacities, which is
 * the one failure this package cannot detect for itself at run time.
 */
function checkMetadata(snapshot) {
  const at = 'lib/metadata.json'
  if (!isPlainObject(snapshot)) return fail(`${at} must be a JSON object`)
  if (typeof snapshot.source !== 'string' || snapshot.source.length === 0) fail(`${at}: "source" must name where the facts came from`)
  if (!Array.isArray(snapshot.providers) || snapshot.providers.length === 0) fail(`${at}: "providers" must list the registries merged`)
  if (Number.isNaN(Date.parse(snapshot.generatedAt))) fail(`${at}: "generatedAt" must be a date`)
  const models = snapshot.models
  if (!isPlainObject(models) || Object.keys(models).length === 0) return fail(`${at}: "models" must be a non-empty object`)
  for (const [id, facts] of Object.entries(models)) {
    if (!isPlainObject(facts)) {
      fail(`${at}: "${id}" must be an object`)
      continue
    }
    for (const field of ['contextWindow', 'maxTokens']) {
      if (!isPositiveInteger(facts[field])) fail(`${at}: "${id}" ${field} must be a positive integer`)
    }
    if (!Array.isArray(facts.input) || facts.input.length === 0) {
      fail(`${at}: "${id}" input must be a non-empty list`)
    } else {
      for (const modality of facts.input) {
        if (!MODALITIES.includes(modality)) fail(`${at}: "${id}" input names "${modality}", which is not a modality`)
      }
    }
    if (typeof facts.reasoning !== 'boolean') fail(`${at}: "${id}" reasoning must be a boolean`)
  }
}

async function main() {
  const manifest = readJson('package.json')
  const patchRelative = checkManifest(manifest)
  if (patchRelative) checkPatch(patchRelative, manifest)
  const clientRelative = checkClientManifest(manifest)
  if (clientRelative) checkClientBundle(manifest, clientRelative)

  const {
    CHAT_MODEL_PATTERNS,
    DISCOVERY_DEFAULTS,
    FALLBACK_MODELS,
    NON_CHAT_MODEL_PATTERNS,
  } = await import('../lib/catalog.js')
  checkCatalog(FALLBACK_MODELS)
  checkDiscoveryDefaults(DISCOVERY_DEFAULTS)
  checkPatterns(CHAT_MODEL_PATTERNS, NON_CHAT_MODEL_PATTERNS, FALLBACK_MODELS)
  const metadata = readJson('lib/metadata.json')
  checkMetadata(metadata)
  for (const entry of FALLBACK_MODELS) {
    if (!(entry.id in (metadata.models ?? {}))) {
      fail(`lib/metadata.json: shipped model "${entry.id}" is missing, so its facts would come from the fallback catalog alone`)
    }
  }

  if (problems.length > 0) {
    console.error(`validate: ${problems.length} problem(s)`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log('validate: ok')
  console.log(`  package: ${manifest.name}@${manifest.version}`)
  console.log(`  patch:   ${patchRelative}`)
  console.log(`  client:  ${clientRelative} (platform ${manifest.dsh.client.platform})`)
  console.log(`  models:  ${FALLBACK_MODELS.length} fallback (${FALLBACK_MODELS.map((m) => m.id).join(', ')})`)
  console.log(`  filter:  ${CHAT_MODEL_PATTERNS.length} include / ${NON_CHAT_MODEL_PATTERNS.length} exclude patterns`)
  console.log(`  facts:   ${Object.keys(metadata.models).length} from ${metadata.providers.join(' + ')} (${metadata.generatedAt.slice(0, 10)})`)
}

main().catch((error) => {
  console.error(`validate: ${error.message}`)
  process.exit(1)
})
