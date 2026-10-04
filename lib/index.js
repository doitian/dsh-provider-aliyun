/**
 * Aliyun DashScope (Bailian) as a DeepSeek Harness model provider.
 *
 * This plugin registers one provider route, `aliyun`, on the harness LLM seam.
 * It owns the route outright — endpoint, credential reference, protocol, and the
 * model catalog — so a profile needs no model list, and `pnpm update` is how the
 * package moves forward.
 *
 * The catalog it advertises is live rather than shipped: {@link ./discovery.js}
 * asks the configured endpoint which models it serves, {@link ./catalog.js}
 * supplies the fallback membership and the model facts, and {@link ./models.js}
 * decides what those two add up to. A profile can still pin the whole thing by
 * setting `models`, and `discovery.enabled: false` turns the live half off.
 *
 * ## Two ways to configure it, and why both work
 *
 * The fields below are `.volatile()`, which is what makes them editable from the
 * Web **Models** page: the settings service refuses a write to a field that is
 * not volatile, and a volatile field becomes a stable reference this plugin
 * reads through `.get()` instead of a value resolved once at mount. That in turn
 * is why {@link ./adapter.js} reads the route facts on every rebuild: a settings
 * write moves the endpoint under a *mounted* plugin rather than remounting it.
 *
 * A profile that would rather keep the values in `cordis.patch.yml` loses
 * nothing — the same fields are ordinary configuration, and a config edit
 * remounts the plugin exactly as it always did.
 *
 * @module @doitian/dsh-provider-aliyun
 */
import { LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

import { createAliyunAdapter } from './adapter.js'
import {
  CHAT_MODEL_PATTERNS,
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DISCOVERY_DEFAULTS,
  DISCOVERY_TTL_MS,
  DISCOVERY_WAIT_MS,
  DISPLAY_NAME,
  FALLBACK_MODELS,
  NON_CHAT_MODEL_PATTERNS,
  ROUTE,
} from './catalog.js'
import { DEFAULT_DISCOVERY_TIMEOUT_MS, createModelDiscovery } from './discovery.js'
// A build-time snapshot of Alibaba model facts; `npm run generate:metadata`
// refreshes it. Nothing at run time talks to the registry it came from.
import metadataSnapshot from './metadata.json' with { type: 'json' }
import { compilePatterns, createMetadataIndex, mergeCatalog, selectIds } from './models.js'

/** Entry name, used for logging and as the settings namespace fallback. */
export const name = 'llm-aliyun'

/** This plugin registers routes; it needs the LLM seam and nothing else. */
export const inject = ['llm']

/** Every thinking level a model's `thinkingLevelMap` may name. */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Accepted input modalities. */
const MODALITIES = ['text', 'image']

/** One catalog entry, as a profile may override it. */
const modelSchema = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  input: z.array(z.union(MODALITIES)),
  reasoning: z.boolean(),
  thinkingLevelMap: z.dict(z.union([z.string(), z.const(null)])),
  // Wire switches for this model alone, merged over the route's. The same shape
  // the catalog states, so a profile that replaces `models` can keep a model the
  // endpoint treats differently — an effort-bearing model, say — working.
  compat: z.dict(z.union([z.boolean(), z.string(), z.number()])),
})

/**
 * Plugin configuration.
 *
 * Every field defaults to something serviceable, so the bundle's patch mounts
 * this plugin with an empty config and the route works as soon as a key
 * resolves. `models` is the fallback catalog *and* the metadata table: discovery
 * decides which ids the route advertises, and an id named here keeps the
 * capacities written here.
 *
 * Each editable node is marked `.volatile()`, which does two things: it makes
 * the field a reference read with `.get()` rather than a value frozen at mount,
 * and it is what lets the settings service write to it at all. The mark goes on
 * whole nodes — `models`, `discovery` — because a volatile field may not sit
 * inside another volatile field.
 */
export const Config = z.object({
  displayName: z.string().default(DISPLAY_NAME).volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  baseURL: z.string().default(DEFAULT_BASE_URL).volatile(),
  models: z.array(modelSchema).default(FALLBACK_MODELS).volatile(),
  reasoning: z.union(THINKING_LEVELS).volatile(),
  headers: z.dict(z.string()).volatile(),
  discovery: z.object({
    enabled: z.boolean().default(true),
    filter: z.union(['chat', 'patterns', 'all']).default('chat'),
    include: z.array(z.string()).default([...CHAT_MODEL_PATTERNS]),
    exclude: z.array(z.string()).default([...NON_CHAT_MODEL_PATTERNS]),
    ttlMs: z.number().step(1).min(0).default(DISCOVERY_TTL_MS),
    waitMs: z.number().step(1).min(0).default(DISCOVERY_WAIT_MS),
    timeoutMs: z.number().step(1).min(1).default(DEFAULT_DISCOVERY_TIMEOUT_MS),
    contextWindow: z.number().step(1).min(1).default(DISCOVERY_DEFAULTS.contextWindow),
    maxTokens: z.number().step(1).min(1).default(DISCOVERY_DEFAULTS.maxTokens),
    input: z.array(z.union(MODALITIES)).default([...DISCOVERY_DEFAULTS.input]),
  }).volatile(),
})

/**
 * Read one configuration field, volatile or not.
 *
 * A field marked `.volatile()` resolves to a reference, so the plugin reads it
 * through `.get()`. Accepting a plain value too is not defensive padding: the
 * same schema is called directly by the tests, and a value that has already been
 * unwrapped — as `plainConfig` does for the settings surface — must read the
 * same way.
 *
 * @param {unknown} field - a config field, as the resolver produced it.
 * @returns {unknown} its current value.
 */
function live(field) {
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') return field.get()
  return field
}

/**
 * The configuration as plain values, read fresh.
 *
 * Everything downstream reads the route through this rather than through the
 * config object, so a value written on the Models page is what the next read
 * sees without any remount. Defaults are restated here only for the fields whose
 * absence is legal at this level: a schema call applies them, but a hand-built
 * config in a test does not.
 *
 * @param {object} config - the resolved {@link Config}.
 * @returns {object} the same shape, as plain data.
 */
export function liveConfig(config) {
  const discovery = live(config.discovery) ?? {}
  return {
    displayName: live(config.displayName) ?? DISPLAY_NAME,
    apiKeyEnv: live(config.apiKeyEnv) ?? DEFAULT_API_KEY_ENV,
    baseURL: live(config.baseURL) ?? DEFAULT_BASE_URL,
    models: live(config.models) ?? [],
    reasoning: live(config.reasoning),
    headers: live(config.headers),
    discovery: {
      enabled: discovery.enabled ?? true,
      filter: discovery.filter ?? 'chat',
      include: discovery.include ?? [...CHAT_MODEL_PATTERNS],
      exclude: discovery.exclude ?? [...NON_CHAT_MODEL_PATTERNS],
      ttlMs: discovery.ttlMs ?? DISCOVERY_TTL_MS,
      waitMs: discovery.waitMs ?? DISCOVERY_WAIT_MS,
      timeoutMs: discovery.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
      contextWindow: discovery.contextWindow ?? DISCOVERY_DEFAULTS.contextWindow,
      maxTokens: discovery.maxTokens ?? DISCOVERY_DEFAULTS.maxTokens,
      input: discovery.input ?? [...DISCOVERY_DEFAULTS.input],
    },
  }
}

/** Whether two plain values are equal, cheaply when they are the same object. */
function sameJson(a, b) {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

/** Whether two live configurations differ at all. */
function configMoved(a, b) {
  return a.displayName !== b.displayName
    || a.apiKeyEnv !== b.apiKeyEnv
    || a.baseURL !== b.baseURL
    || a.reasoning !== b.reasoning
    || !sameJson(a.headers, b.headers)
    || !sameJson(a.models, b.models)
    || !sameJson(a.discovery, b.discovery)
}

/** Whether a change is one the discovery client itself holds. */
function discoveryMoved(a, b) {
  return a.baseURL !== b.baseURL
    || a.apiKeyEnv !== b.apiKeyEnv
    || !sameJson(a.headers, b.headers)
    || !sameJson(a.models, b.models)
    || !sameJson(a.discovery, b.discovery)
}

/**
 * Resolve this route's credential reference for one request.
 *
 * The reference is resolved through the harness credential seam, which reads
 * the managed credential document and the launching environment. A reference
 * that resolves to nothing fails the request before any network I/O, naming
 * the reference to store — the alternative, sending no key, turns a
 * configuration mistake into an opaque upstream 401.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {(provider: string, profile: object) => Promise<string | undefined>} the resolver.
 */
function apiKeyResolver(ctx) {
  return async (provider, profile) => {
    const ref = profile.apiKeyEnv
    if (ref === undefined) return undefined
    const credentials = ctx.get('credentials')
    const hit = credentials === undefined ? undefined : (await credentials.resolve(ref))?.value
    if (hit !== undefined && hit.length > 0) return hit
    throw new LlmError(
      `llm-aliyun: no credential for provider route "${provider}"; its profile resolves ${ref}, which is not set — store ${ref} through the credentials service (the Web Models page writes it) or export it in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }
}

/**
 * Mount the route.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {object} config - the resolved {@link Config}.
 */
export function apply(ctx, config) {
  // The settings namespace is the entry id, so the Models page addresses this
  // plugin's own row rather than any other adapter's section.
  const settingsNs = ctx.fiber?.entry?.options.id ?? name

  // This row's configuration surface is this package's own client half, so say
  // so. The settings service reports the policy as `autoGenerate: false`, which
  // is the marker for "this plugin ships its own page" — and the registration is
  // skipped entirely in a deployment composed without the settings service.
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), 'llm-aliyun: settings presentation')
  })

  /** The configuration as it stands, refreshed by {@link sync}. */
  let current = liveConfig(config)
  /** The discovery state for {@link current}; its callbacks read this binding. */
  let discovery

  // A workspace listing is the account's whole catalogue, so what it is allowed
  // to advertise is filtered before it becomes a catalog. Two signals decide
  // that — the profile's patterns and the metadata snapshot's own statement that
  // a model answers with text — and a pattern that does not compile costs itself
  // and nothing else.
  const metadata = createMetadataIndex(metadataSnapshot)
  const complain = (field) => (source, error) => {
    ctx.logger?.warn?.(`llm-aliyun: discovery.${field} pattern ${JSON.stringify(source)} is not a valid regular expression (${error.message}); ignoring it`)
  }
  const filterFor = (settings) => ({
    mode: settings.discovery.filter,
    include: compilePatterns(settings.discovery.include, complain('include')),
    exclude: compilePatterns(settings.discovery.exclude, complain('exclude')),
    // Naming a model in `models` is a stronger statement than any pattern.
    pinned: settings.models.map((entry) => entry.id),
    known: (id) => metadata.knows(id),
  })
  ctx.logger?.debug?.(`llm-aliyun: model metadata snapshot from ${metadataSnapshot.source} (${metadata.size} models, generated ${metadataSnapshot.generatedAt})`)

  const resolveApiKey = apiKeyResolver(ctx)

  // The adapter reads its route facts on every rebuild, so a settings write is
  // visible to the next operation without re-registering anything.
  const { adapter, setCatalog } = createAliyunAdapter({
    facts: () => current,
    // What the route advertises until a listing arrives.
    models: current.models,
    resolveApiKey,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger?.warn?.(`llm-aliyun: unusable replay state on assistant history for route "${provider}/${model}"; sending that message as provider-neutral content (${reason})`)
    },
    // A read is the moment a stale listing is noticed, and a model list is the
    // one read allowed to wait for the endpoint's answer. It is also the moment
    // a configuration change is noticed when no event said so.
    onRead: () => {
      sync()
      discovery.ensureFresh()
    },
    settle: () => discovery.settle({ maxWaitMs: current.discovery.waitMs }),
  })

  /**
   * Advertise the catalog the configuration and the listing add up to, and tell
   * the surfaces that read the old one.
   *
   * A model picker caches the catalog it read and re-reads it on
   * `llm/adapters-updated` — the payload-free event the LLM seam publishes when
   * a route set changes. Swapping the catalog alone is invisible to it, so the
   * picker would keep showing whatever it read at startup until something else
   * moved. Re-registering the same route is the documented way to publish that
   * event: it changes no route, only the topology version the event announces.
   */
  const announceCatalog = () => {
    setCatalog(mergeCatalog({
      ids: selectIds(discovery.ids() ?? [], filterFor(current)),
      fallback: current.models,
      defaults: {
        contextWindow: current.discovery.contextWindow,
        maxTokens: current.discovery.maxTokens,
        input: current.discovery.input,
      },
      metadata,
    }))
    registration.replace([ROUTE])
  }

  /** The discovery client for one configuration. */
  const createDiscoveryFor = (settings) => createModelDiscovery({
    baseURL: settings.baseURL,
    apiKeyEnv: settings.apiKeyEnv,
    enabled: settings.discovery.enabled,
    ttlMs: settings.discovery.ttlMs,
    timeoutMs: settings.discovery.timeoutMs,
    headers: settings.headers,
    fallbackModels: settings.models,
    resolveApiKey: () => resolveApiKey(ROUTE, { apiKeyEnv: settings.apiKeyEnv }),
    onChange: () => announceCatalog(),
    onError: (message) => ctx.logger?.warn?.(message),
  })

  /** The row this plugin owns on the Models page. */
  const directoryEntry = (settings) => ({
    provider: ROUTE,
    displayName: settings.displayName,
    settingsNs,
    settingsPath: [],
    declared: true,
  })

  // Discovery is built before the route is registered, because registration
  // publishes `llm/adapters-updated` and a listener that reacts by reading the
  // route must find every callback it can reach already defined.
  discovery = createDiscoveryFor(current)

  // Both registrations are disposed with the plugin's fiber.
  const registration = ctx.llm.registerAdapter([ROUTE], adapter)

  // The directory entry is what gives the route a row on the Models page. It is
  // refused if another adapter already declares `aliyun` — which is what happens
  // when a profile still configures an `aliyun` route through `llm-pi-ai`.
  const directory = ctx.llm.registerConfigurableProviders([directoryEntry(current)])

  // A configuration surface can interrogate this route's endpoint — even before
  // a key is stored, by passing the draft's own. Registered once: the callback
  // reads the `discovery` binding, so a configuration change that rebuilds the
  // client is visible without re-registering the offer.
  ctx.llm.registerModelDiscovery(settingsNs, (request, signal) => discovery.probe(request, signal))

  /**
   * Adopt a configuration that moved under the mounted plugin.
   *
   * This is what a settings write from the Models page looks like from here: the
   * fields are volatile, so the write updates the references in place and the
   * plugin is *not* remounted. Everything derived from the configuration —
   * discovery's endpoint and pacing, the row's display name, the advertised
   * catalog — is re-derived here, and only when something actually moved.
   *
   * Called from every read as well as from the settings event, so a write lands
   * even if no event reaches this plugin; the comparison makes the second call
   * free and the whole function safe to re-enter.
   */
  function sync() {
    const next = liveConfig(config)
    if (!configMoved(current, next)) return
    const previous = current
    current = next

    if (previous.displayName !== next.displayName) directory.replace([directoryEntry(next)])

    // A moved endpoint, credential reference, pin list, or filter invalidates
    // everything discovery derived. A fresh client is the honest answer: the
    // listing in hand belongs to the previous configuration, and the failure
    // backoff should not hold a corrected endpoint back. Its own state starts
    // empty, so the announcement below puts the new fallback catalog in front of
    // any picker rather than leaving the old endpoint's list on screen.
    if (discoveryMoved(previous, next)) {
      discovery = createDiscoveryFor(next)
      discovery.ensureFresh({ force: true })
      announceCatalog()
    }
  }

  // A stored key is exactly the event that makes a failed listing attempt worth
  // retrying immediately, and a settings write is the other way configuration
  // arrives while this plugin is mounted.
  ctx.on('credentials/reference-updated', (ref) => {
    if (typeof ref === 'string' && ref === current.apiKeyEnv) discovery.ensureFresh({ force: true })
  })
  ctx.on('settings/document-updated', (ns) => {
    if (ns === settingsNs) sync()
  })

  discovery.ensureFresh()
}
