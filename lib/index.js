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
})

/**
 * Plugin configuration.
 *
 * Every field defaults to something serviceable, so the bundle's patch mounts
 * this plugin with an empty config and the route works as soon as a key
 * resolves. `models` is the fallback catalog *and* the metadata table: discovery
 * decides which ids the route advertises, and an id named here keeps the
 * capacities written here.
 */
export const Config = z.object({
  displayName: z.string().default(DISPLAY_NAME),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  models: z.array(modelSchema).default(FALLBACK_MODELS),
  reasoning: z.union(THINKING_LEVELS),
  headers: z.dict(z.string()),
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
  }),
})

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
  const discoveryConfig = config.discovery
  const fallback = config.models
  const resolveApiKey = apiKeyResolver(ctx)

  // A workspace listing is the account's whole catalogue, so what it is allowed
  // to advertise is filtered before it becomes a catalog. Two signals decide
  // that — the profile's patterns and the metadata snapshot's own statement that
  // a model answers with text — and a pattern that does not compile costs itself
  // and nothing else.
  const metadata = createMetadataIndex(metadataSnapshot)
  const complain = (field) => (source, error) => {
    ctx.logger?.warn?.(`llm-aliyun: discovery.${field} pattern ${JSON.stringify(source)} is not a valid regular expression (${error.message}); ignoring it`)
  }
  const filter = {
    mode: discoveryConfig.filter,
    include: compilePatterns(discoveryConfig.include, complain('include')),
    exclude: compilePatterns(discoveryConfig.exclude, complain('exclude')),
    // Naming a model in `models` is a stronger statement than any pattern.
    pinned: fallback.map((entry) => entry.id),
    known: (id) => metadata.knows(id),
  }
  ctx.logger?.debug?.(`llm-aliyun: model metadata snapshot from ${metadataSnapshot.source} (${metadata.size} models, generated ${metadataSnapshot.generatedAt})`)

  // The adapter is built first only because discovery's change callback needs
  // `setCatalog`; its own discovery callbacks are closures that run later.
  const { adapter, setCatalog } = createAliyunAdapter({
    displayName: config.displayName,
    apiKeyEnv: config.apiKeyEnv,
    baseURL: config.baseURL,
    // What the route advertises until a listing arrives.
    models: fallback,
    reasoning: config.reasoning,
    headers: config.headers,
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
    // one read allowed to wait for the endpoint's answer.
    onRead: () => discovery.ensureFresh(),
    settle: () => discovery.settle({ maxWaitMs: discoveryConfig.waitMs }),
  })

  const discovery = createModelDiscovery({
    baseURL: config.baseURL,
    apiKeyEnv: config.apiKeyEnv,
    enabled: discoveryConfig.enabled,
    ttlMs: discoveryConfig.ttlMs,
    timeoutMs: discoveryConfig.timeoutMs,
    headers: config.headers,
    fallbackModels: fallback,
    resolveApiKey: () => resolveApiKey(ROUTE, { apiKeyEnv: config.apiKeyEnv }),
    onChange: (ids) => setCatalog(mergeCatalog({
      ids: selectIds(ids, filter),
      fallback,
      defaults: {
        contextWindow: discoveryConfig.contextWindow,
        maxTokens: discoveryConfig.maxTokens,
        input: discoveryConfig.input,
      },
      metadata,
    })),
    onError: (message) => ctx.logger?.warn?.(message),
  })

  // Both registrations are disposed with the plugin's fiber.
  ctx.llm.registerAdapter([ROUTE], adapter)

  // The directory entry is what gives the route a row on the Models page. It is
  // refused if another adapter already declares `aliyun` — which is what happens
  // when a profile still configures an `aliyun` route through `llm-pi-ai`.
  ctx.llm.registerConfigurableProviders([{
    provider: ROUTE,
    displayName: config.displayName,
    settingsNs,
    settingsPath: [],
    declared: true,
  }])

  // A configuration surface can interrogate this route's endpoint — even before
  // a key is stored, by passing the draft's own.
  ctx.llm.registerModelDiscovery(settingsNs, (request, signal) => discovery.probe(request, signal))

  // The key can arrive at any time, and a stored key is exactly the event that
  // makes a failed listing attempt worth retrying immediately.
  ctx.on('credentials/reference-updated', (ref) => {
    if (typeof ref === 'string' && ref === config.apiKeyEnv) discovery.ensureFresh({ force: true })
  })

  discovery.ensureFresh()
}
