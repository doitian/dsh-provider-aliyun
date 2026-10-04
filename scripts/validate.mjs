#!/usr/bin/env node
/**
 * Static validation for this preset bundle.
 *
 * It is deliberately a *mirror* of the constraints the harness enforces, not a
 * substitute for them: `@deepseek-ai/dsh-llm-pi-ai` re-checks everything here
 * when the profile composes, and refuses an unserviceable profile. The point is
 * to fail in CI, with a readable message, instead of in someone's profile.
 *
 * Mirrored from `@deepseek-ai/dsh-llm-pi-ai` (lib/index.js):
 *   - `PROTOCOLS`        — the wire protocols a configured route may name
 *   - `COMPLETIONS_COMPAT_GATE` — the compat fields `openai-completions` accepts
 *   - `MODALITIES`       — text | image
 *   - `THINKING_LEVELS`  — off, minimal, low, medium, high, xhigh, max
 *   - `resolveModelReasoning` / `resolveRouteModels` — model rules below
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import yaml from 'js-yaml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']
const MODALITIES = ['text', 'image']
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Every `OpenAICompletionsCompat` field this harness offers for configuration. */
const COMPLETIONS_COMPAT = new Set([
  'supportsStore',
  'supportsDeveloperRole',
  'supportsReasoningEffort',
  'supportsUsageInStreaming',
  'supportsFinishReason',
  'maxTokensField',
  'requiresToolResultName',
  'requiresAssistantAfterToolResult',
  'requiresThinkingAsText',
  'requiresReasoningContentOnAssistantMessages',
  'thinkingFormat',
  'chatTemplateKwargs',
  'chatTemplateArgs',
  'supportsThinkingTokenBudget',
  'thinkingTokenBudgetField',
  'vllmPriority',
  'supportsStrictMode',
  'cacheControlFormat',
  'supportsLongCacheRetention',
])

const problems = []
const fail = (message) => problems.push(message)

const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'))
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0
const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Wire the manifest and the patch together the way the loader will read them. */
function checkManifest(manifest) {
  const patchPath = manifest?.dsh?.bundle?.patch
  if (typeof patchPath !== 'string' || patchPath.length === 0) {
    fail('package.json: "dsh.bundle.patch" must name the bundle patch file')
    return undefined
  }
  const relative = patchPath.replace(/^\.\//, '')
  if (!(manifest.files ?? []).includes(relative)) {
    fail(`package.json: "files" must include "${relative}", or npm drops it from the tarball`)
  }
  // npm publishes package.json, README and LICENSE regardless of "files";
  // anything else the bundle needs at runtime must be listed.
  if (!(manifest.files ?? []).includes('lib/index.js')) {
    fail('package.json: "files" must include "lib/index.js"')
  }
  const main = manifest.main
  if (typeof main === 'string' && !(manifest.files ?? []).includes(main.replace(/^\.\//, ''))) {
    fail(`package.json: "files" must include the "main" module "${main}"`)
  }
  if (!manifest.main) fail('package.json: "main" is required so the package resolves as a module')
  if (manifest.publishConfig?.access !== 'public') {
    fail('package.json: "publishConfig.access" must be "public" for a scoped package')
  }
  return relative
}

function checkModel(route, model, seen) {
  const at = `providers.${route}.models`
  if (!isPlainObject(model)) return fail(`${at}: every entry must be a mapping`)
  const id = model.id
  if (typeof id !== 'string' || id.length === 0) return fail(`${at}: a model has an empty id`)
  if (seen.has(id)) fail(`${at}: model "${id}" is listed more than once`)
  seen.add(id)

  for (const field of ['contextWindow', 'maxTokens']) {
    if (!isPositiveInteger(model[field])) {
      fail(`${at}: "${id}" ${field} must be a positive integer`)
    }
  }
  if (model.input !== undefined) {
    if (!Array.isArray(model.input) || model.input.length === 0) {
      fail(`${at}: "${id}" input must be a non-empty list when present`)
    } else {
      for (const modality of model.input) {
        if (!MODALITIES.includes(modality)) {
          fail(`${at}: "${id}" input names "${modality}", which is not a modality`)
        }
      }
    }
  }

  const efforts = model.reasoningEfforts
  if (efforts === undefined || efforts === false) return
  if (!isPlainObject(efforts) || Object.keys(efforts).length === 0) {
    fail(`${at}: "${id}" reasoningEfforts must be false, a non-empty mapping, or absent`)
    return
  }
  const keys = Object.keys(efforts)
  for (const level of keys) {
    if (!THINKING_LEVELS.includes(level)) {
      fail(`${at}: "${id}" reasoningEfforts."${level}" is not a thinking level`)
      continue
    }
    const wire = efforts[level]
    if (wire === null) {
      if (level !== 'off') {
        fail(`${at}: "${id}" reasoningEfforts.${level} needs a wire value; only "off" may be null`)
      }
    } else if (typeof wire !== 'string' || wire.length === 0) {
      fail(`${at}: "${id}" reasoningEfforts.${level} must be a non-empty string`)
    }
  }
  const beyondOff = keys.filter((level) => level !== 'off' && efforts[level] !== null)
  if (beyondOff.length === 0) {
    fail(`${at}: "${id}" reasoningEfforts offers no level beyond "off"; use false instead`)
  }
}

function checkRoute(route, profile) {
  const at = `providers.${route}`
  if (!isPlainObject(profile)) return fail(`${at}: must be a mapping`)

  if (!PROTOCOLS.includes(profile.api)) {
    fail(`${at}: api must be one of ${PROTOCOLS.join(', ')}, got ${JSON.stringify(profile.api)}`)
  }
  for (const field of ['displayName', 'baseURL', 'apiKeyEnv']) {
    const value = profile[field]
    if (typeof value !== 'string' || value.length === 0) {
      fail(`${at}: ${field} is required and must be a non-empty string`)
    }
  }
  if (typeof profile.baseURL === 'string' && !/^https?:\/\//.test(profile.baseURL)) {
    fail(`${at}: baseURL must be an http(s) URL`)
  }
  if (typeof profile.displayName === 'string' && /^sk-|^[A-Za-z0-9_-]{20,}$/.test(profile.displayName)) {
    fail(`${at}: displayName looks like a secret; it is rendered by selector surfaces`)
  }

  const compat = profile.compat
  if (compat !== undefined) {
    if (!isPlainObject(compat)) {
      fail(`${at}: compat must be a mapping`)
    } else if (profile.api === 'openai-completions') {
      for (const field of Object.keys(compat)) {
        if (!COMPLETIONS_COMPAT.has(field)) {
          fail(`${at}: compat."${field}" is not configurable on ${profile.api}`)
        }
      }
    }
  }

  if (!Array.isArray(profile.models) || profile.models.length === 0) {
    // A hand-declared route needs `api`, `baseURL` and a non-empty `models`
    // list: pi-ai ships no catalog for it, so nothing else can supply models.
    return fail(`${at}: models must be a non-empty list for a route pi-ai does not ship`)
  }
  const seen = new Set()
  for (const model of profile.models) checkModel(route, model, seen)
}

function main() {
  const manifest = readJson('package.json')
  const patchRelative = checkManifest(manifest)
  if (!patchRelative) return

  let patch
  try {
    patch = yaml.load(readFileSync(join(root, patchRelative), 'utf8'))
  } catch (error) {
    return fail(`${patchRelative}: not valid YAML — ${error.message}`)
  }
  if (!Array.isArray(patch)) {
    return fail(`${patchRelative}: a profile patch is a top-level YAML array of entries`)
  }

  const targets = patch.filter((entry) => isPlainObject(entry) && entry.id === 'llm-pi-ai')
  if (targets.length !== 1) {
    return fail(`${patchRelative}: expected exactly one "llm-pi-ai" entry, found ${targets.length}`)
  }
  const [entry] = targets
  if (entry.name !== '@deepseek-ai/dsh-llm-pi-ai') {
    fail(`${patchRelative}: the "llm-pi-ai" entry must assert name '@deepseek-ai/dsh-llm-pi-ai'`)
  }

  const providers = entry.config?.providers
  if (!isPlainObject(providers) || Object.keys(providers).length === 0) {
    return fail(`${patchRelative}: the entry must configure at least one provider route`)
  }
  for (const [route, profile] of Object.entries(providers)) checkRoute(route, profile)

  if (!('aliyun' in providers)) {
    fail(`${patchRelative}: this bundle is meant to declare the "aliyun" route`)
  }

  if (problems.length > 0) {
    console.error(`validate: ${problems.length} problem(s)`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log('validate: ok')
  console.log(`  package:  ${manifest.name}@${manifest.version}`)
  console.log(`  patch:    ${patchRelative}`)
  console.log(`  routes:   ${Object.keys(providers).join(', ')}`)
}

main()
