/**
 * Aliyun DashScope (Bailian) as a DeepSeek Harness model provider.
 *
 * This plugin registers one provider route, `aliyun`, on the harness LLM seam.
 * It owns the route outright — endpoint, credential reference, protocol, and
 * the Qwen model catalog in {@link ./catalog.js} — so a profile needs no model
 * list, and `pnpm update` is how the catalog moves forward.
 *
 * @module @doitian/dsh-provider-aliyun
 */
import { LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

import { createAliyunAdapter } from './adapter.js'
import {
  ALIYUN_MODELS,
  DEFAULT_API_KEY_ENV,
  DEFAULT_BASE_URL,
  DISPLAY_NAME,
  ROUTE,
} from './catalog.js'

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
 * resolves. `models` defaults to the shipped catalog, which is what the
 * settings surface shows as inherited rows until someone edits them.
 */
export const Config = z.object({
  displayName: z.string().default(DISPLAY_NAME),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  models: z.array(modelSchema).default(ALIYUN_MODELS),
  reasoning: z.union(THINKING_LEVELS),
  headers: z.dict(z.string()),
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

  const adapter = createAliyunAdapter({
    displayName: config.displayName,
    apiKeyEnv: config.apiKeyEnv,
    baseURL: config.baseURL,
    models: config.models,
    reasoning: config.reasoning,
    headers: config.headers,
    resolveApiKey: apiKeyResolver(ctx),
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
    onReplayDegrade: ({ provider, model, reason }) => {
      ctx.logger?.warn?.(`llm-aliyun: unusable replay state on assistant history for route "${provider}/${model}"; sending that message as provider-neutral content (${reason})`)
    },
  })

  // Both registrations are disposed with the plugin's fiber.
  ctx.llm.registerAdapter([ROUTE], adapter)

  // The directory entry is what gives the route a row on the Models page, and
  // with it the API-key field. It is refused if another adapter already
  // declares `aliyun` — which is what happens when a profile still configures
  // an `aliyun` route through `llm-pi-ai`; remove that route to use this plugin.
  ctx.llm.registerConfigurableProviders([{
    provider: ROUTE,
    displayName: config.displayName,
    settingsNs,
    settingsPath: [],
    declared: true,
  }])
}
