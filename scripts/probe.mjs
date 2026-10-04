#!/usr/bin/env node
/**
 * Ask an Aliyun endpoint which models it serves.
 *
 * This is the check the test suite cannot make: whether *your* endpoint answers
 * a model listing at all, and which ids come back. It runs the same code the
 * plugin runs — `fetchListing` from `lib/discovery.js`, merged by the same
 * `mergeCatalog` — so a pass here means the route will advertise that listing,
 * and a failure here prints the exact message the plugin would log.
 *
 * Nothing is sent anywhere but the endpoint, and the credential is never
 * printed: only where it came from.
 *
 *   npm run probe
 *   npm run probe -- --base-url https://llm-<workspace-id>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
 *   npm run probe -- --ref DASHSCOPE_API_KEY --profile desktop
 *
 * The endpoint and credential reference default to what this machine's profile
 * patch configures for the `llm-aliyun` entry, so the usual invocation is bare.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import yaml from 'js-yaml'

import {
  CHAT_MODEL_PATTERNS,
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DISCOVERY_DEFAULTS,
  FALLBACK_MODELS,
  NON_CHAT_MODEL_PATTERNS,
} from '../lib/catalog.js'
import { fetchListing, listingUrl } from '../lib/discovery.js'
import metadataSnapshot from '../lib/metadata.json' with { type: 'json' }
import { compilePatterns, createMetadataIndex, mergeCatalog, selectIds } from '../lib/models.js'

const argv = process.argv.slice(2)

/** One `--name value` argument, or `undefined`. */
function option(name) {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? undefined : argv[at + 1]
}

/** Whether `--name` was passed at all. */
const has = (name) => argv.includes(`--${name}`)

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profile = option('profile') ?? process.env.DSH_PROFILE ?? 'desktop'

/** The plugin's entry in a profile patch, or `undefined`. */
function configuredEntry() {
  const path = join(dshHome, 'profiles', profile, 'cordis.patch.yml')
  if (!existsSync(path)) return undefined
  let layers
  try {
    layers = yaml.load(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  if (!Array.isArray(layers)) return undefined
  for (const layer of layers) {
    if (layer?.id !== 'llm-aliyun' && layer?.name !== '@doitian/dsh-provider-aliyun') continue
    return { path, config: layer.config ?? {} }
  }
  return undefined
}

const entry = configuredEntry()
const baseURL = option('base-url') ?? process.env.ALIYUN_BASE_URL ?? entry?.config.baseURL ?? DEFAULT_BASE_URL
const ref = option('ref') ?? entry?.config.apiKeyEnv ?? DEFAULT_API_KEY_ENV

/**
 * Resolve the credential reference the way the local store does, without ever
 * returning it to the terminal: the launch environment wins, then the stored
 * file, then the two `.env` layers.
 */
function resolveApiKey(name) {
  if (typeof process.env[name] === 'string' && process.env[name].length > 0) {
    return { value: process.env[name], source: 'the launch environment' }
  }
  const stored = join(dshHome, '.credentials.yaml')
  if (existsSync(stored)) {
    try {
      const refs = yaml.load(readFileSync(stored, 'utf8'))?.refs
      const value = refs?.[name]
      if (typeof value === 'string' && value.length > 0) {
        return { value, source: `refs.${name} in ${stored}` }
      }
    } catch (error) {
      return { error: `${stored} is not readable YAML: ${error.message}` }
    }
  }
  for (const path of [join(process.cwd(), '.env'), join(dshHome, '.env')]) {
    if (!existsSync(path)) continue
    const line = readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .find((candidate) => candidate.startsWith(`${name}=`))
    const value = line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, '')
    if (value !== undefined && value.length > 0) return { value, source: path }
  }
  return { error: `no value for ${name} in the launch environment, ${stored}, or a .env file` }
}

const url = listingUrl(baseURL)
console.log('llm-aliyun discovery probe')
console.log(`  endpoint:   ${baseURL}${entry === undefined ? '' : `  (from ${entry.path})`}`)
console.log(`  listing:    ${url}`)
console.log(`  credential: ${ref}${has('base-url') || entry === undefined ? '' : '  (from the profile patch)'}`)

const credential = resolveApiKey(ref)
if (credential.error !== undefined) {
  console.log(`  key:        none — ${credential.error}`)
  console.log('              asking anyway: the status alone says whether this endpoint has a listing')
} else {
  console.log(`  key from:   ${credential.source} (value never printed)`)
}

let key
if (credential.value !== undefined) {
  try {
    key = assertUsableApiKey(credential.value, '@doitian/dsh-provider-aliyun', ref)
  } catch (error) {
    console.error(`  ✖ ${error.message}`)
    process.exit(1)
  }
}

let listing
try {
  listing = await fetchListing({ baseURL, ...key === undefined ? {} : { apiKey: key } })
} catch (error) {
  console.error(`  ✖ ${error.message}`)
  console.error('')
  if (/answered 40[13]/.test(error.message)) {
    console.error('That is a credential answer, not a missing feature: the endpoint is there and its')
    console.error(`listing route exists. Store ${ref} and run this again.`)
  } else if (/answered 404/.test(error.message)) {
    console.error('The endpoint exists but serves no model listing, so live discovery cannot work here:')
    console.error('set `models` in the entry config to hand-list what it serves instead.')
  } else {
    console.error('The request never got an answer, so this says nothing about whether the endpoint')
    console.error('has a listing.')
  }
  console.error('')
  console.error('Either way the plugin logs that line and keeps advertising the fallback catalog, so this')
  console.error('is a diagnosis rather than an outage.')
  process.exit(1)
}

// The same filter and the same facts the plugin applies, from the same profile
// entry, so what this prints is what the picker will show rather than what the
// endpoint lists.
const discovery = entry?.config.discovery ?? {}
const metadata = createMetadataIndex(metadataSnapshot)
const ids = selectIds(listing.map((model) => model.id), {
  mode: discovery.filter ?? 'chat',
  include: compilePatterns(discovery.include ?? [...CHAT_MODEL_PATTERNS]),
  exclude: compilePatterns(discovery.exclude ?? [...NON_CHAT_MODEL_PATTERNS]),
  pinned: FALLBACK_MODELS.map((model) => model.id),
  known: (id) => metadata.knows(id),
})
const merged = mergeCatalog({
  ids,
  fallback: FALLBACK_MODELS,
  defaults: DISCOVERY_DEFAULTS,
  metadata,
})
const capacity = (entry) => `${entry.contextWindow.toLocaleString('en-US')} ctx  ${entry.maxTokens.toLocaleString('en-US')} out`
const width = Math.max(...merged.map((entry) => entry.id.length), 4)

console.log(`  ✔ ${listing.length} models listed, ${merged.length} advertised`)
console.log(`    filter: ${discovery.filter ?? 'chat'} (discovery.filter: all advertises the whole listing)`)
console.log(`    metadata: ${metadata.size} models from models.dev, generated ${metadataSnapshot.generatedAt.slice(0, 10)}`)
console.log('')
console.log('  id'.padEnd(width + 6) + 'capacities the route will advertise')
for (const model of merged) {
  const source = FALLBACK_MODELS.some((entry) => entry.id === model.id)
    ? 'catalog'
    : metadata.facts(model.id) === undefined ? 'conservative default' : 'models.dev'
  console.log(`  ${model.id.padEnd(width + 4)}${capacity(model)}   (${source})`)
}
console.log('')
console.log('This is the list the model picker will show for route `aliyun` on the next read.')
