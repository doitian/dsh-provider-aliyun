/**
 * Wire the shipped catalog into the harness LLM seam.
 *
 * The engine is `PiAiAdapter`, exported by `@deepseek-ai/dsh-llm-pi-ai`. It
 * owns the hard part — harness history into pi-ai context, pi-ai events into
 * harness stream chunks, image budgets, replay metadata, idle watchdogs — and
 * is driven entirely through the `config` object below. Reusing it is what
 * keeps this package a catalog plus a few dozen lines instead of a second
 * adapter implementation.
 *
 * ## The contract this file depends on
 *
 * `PiAiAdapter` consumes a route's *resolved profile*. That type is not part of
 * the package's exported surface: it is the shape `resolveProfiles` produces
 * internally, and it is reproduced here. The fields, all of them, are:
 *
 *   provider, displayName, apiKeyEnv, piProvider, catalogError, modelErrors,
 *   configuredMaxTokens, reasoning, thinkingBudgets, retryPolicy, headers,
 *   timeoutMs, websocketConnectTimeoutMs, streamIdleTimeoutMs, transport,
 *   cacheRetention, maxRequestImageBytes, requestImagePixelBudget,
 *   requestImageMaxBytes
 *
 * Model metadata — context window, modalities, thinking levels — is *not* read
 * from the profile. It is read from the pi-ai model descriptors inside
 * `piProvider`, which is why the catalog can live in this package.
 *
 * The catalog it carries is not fixed at mount. Discovery ({@link ./discovery.js})
 * swaps the advertised entries as the endpoint's listing moves, and the swap is
 * a new profile *map* so the adapter's identity-based memoization notices it:
 * every operation already captured keeps the snapshot it started with, and the
 * next read sees the new catalog.
 *
 * The risk this carries: a DSH upgrade that starts reading a new profile field
 * breaks this plugin. `test/adapter.test.mjs` drives the real `PiAiAdapter`
 * against this factory so that such a break shows up as a failing test rather
 * than as a broken route in someone's profile.
 */
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

import { QWEN_COMPAT, ROUTE } from './catalog.js'
import { materializeModels } from './models.js'
import { createPiProvider } from './provider.js'

/** Idle bound on one outstanding stream read, matching the adapter's own default. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

/** Aggregate base64 image payload a request may retain before offload is required. */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024

/** Total-pixel budget for each deterministic request image. */
export const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 4 * 1024 * 1024

/** Encoded-byte target for each request image before base64 expansion. */
export const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024

/**
 * Build the resolved profile for this route.
 *
 * Everything is computed once, when the plugin mounts: the configuration
 * carries no volatile field, so a configuration change remounts the plugin and
 * rebuilds this. That keeps `profiles()` returning one stable map, which is
 * what the adapter's snapshot memoization compares by identity.
 *
 * @param {object} options - route facts.
 * @param {string} options.displayName - label for selectors.
 * @param {string} options.apiKeyEnv - credential reference to resolve per request.
 * @param {string} options.baseURL - endpoint for every model on the route.
 * @param {readonly import('./catalog.js').AliyunModel[]} options.models - the shipped catalog.
 * @param {string} [options.reasoning] - route default thinking level.
 * @param {Record<string, string>} [options.headers] - extra request headers.
 * @returns {object} the resolved profile.
 */
export function buildAliyunProfile(options) {
  const models = materializeModels({
    catalog: options.models,
    provider: ROUTE,
    baseUrl: options.baseURL,
    compat: QWEN_COMPAT,
  })
  return {
    provider: ROUTE,
    displayName: options.displayName,
    apiKeyEnv: options.apiKeyEnv,
    piProvider: createPiProvider({
      id: ROUTE,
      name: options.displayName,
      baseUrl: options.baseURL,
      models,
      api: openAICompletionsApi(),
    }),
    // `piProvider` is always defined here, so the adapter never consults the
    // catalog diagnostic; it exists to keep the profile shape complete.
    catalogError: undefined,
    modelErrors: new Map(),
    // Empty on purpose: the adapter reports these as *explicit* per-model caps,
    // and the catalog's own `maxTokens` already governs the request.
    configuredMaxTokens: new Map(),
    reasoning: options.reasoning,
    headers: options.headers,
    streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    maxRequestImageBytes: DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    requestImagePixelBudget: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  }
}

/**
 * Create the adapter for this route.
 *
 * `auth` is deliberately omitted. The harness resolves the credential reference
 * itself and hands the key to pi-ai as the stream's `apiKey` option, so the
 * credential stores and OAuth context the adapter would otherwise carry are
 * never consulted; `createModels` falls back to in-memory ones.
 *
 * @param {object} options - route facts plus the harness callbacks.
 * @param {string} options.displayName - label for selectors.
 * @param {string} options.apiKeyEnv - credential reference to resolve per request.
 * @param {string} options.baseURL - endpoint for every model on the route.
 * @param {readonly import('./catalog.js').AliyunModel[]} options.models - the catalog to advertise first.
 * @param {string} [options.reasoning] - route default thinking level.
 * @param {Record<string, string>} [options.headers] - extra request headers.
 * @param {(provider: string, profile: object) => Promise<string | undefined>} options.resolveApiKey - credential resolver.
 * @param {() => object | undefined} [options.resolveAttachments] - durable attachment service accessor.
 * @param {(attachments: object, ref: object) => unknown} [options.resolveImageAccess] - image access resolver.
 * @param {(event: object) => void} [options.onReplayDegrade] - replay degradation reporter.
 * @param {() => void} [options.onRead] - called before every operation reads the profile map.
 * @param {() => Promise<void>} [options.settle] - awaited before a model list is answered.
 * @returns {{ adapter: PiAiAdapter, setCatalog: (models: readonly import('./catalog.js').AliyunModel[]) => void }} the adapter to register, and the way to move its catalog.
 */
export function createAliyunAdapter(options) {
  /** The profile map the adapter memoizes by identity; a catalog swap replaces it. */
  let profiles = profilesOver(options.models)

  /** One route's profile for one catalog, as a fresh map. */
  function profilesOver(models) {
    return new Map([[ROUTE, buildAliyunProfile({ ...options, models })]])
  }

  /**
   * `PiAiAdapter` answers `listModels` from its memoized snapshot, and that
   * answer is what the picker reads. Waiting here — and nowhere else — is what
   * lets a picker opened on a cold route show the endpoint's own list instead of
   * the fallback one, while every other read stays off the network.
   */
  class AliyunAdapter extends PiAiAdapter {
    async listModels(provider) {
      await options.settle?.()
      return super.listModels(provider)
    }
  }

  const adapter = new AliyunAdapter({
    // Every operation asks for the profile map, so a stale listing is noticed
    // and refreshed on the way past, without any of those operations waiting.
    profiles: () => {
      options.onRead?.()
      return profiles
    },
    resolveApiKey: options.resolveApiKey,
    resolveAttachments: options.resolveAttachments,
    resolveImageAccess: options.resolveImageAccess,
    onReplayDegrade: options.onReplayDegrade,
  })

  return {
    adapter,
    /**
     * Advertise `models` from the next read on.
     * @param {readonly import('./catalog.js').AliyunModel[]} models - the entries the route now serves.
     */
    setCatalog(models) {
      profiles = profilesOver(models)
    },
  }
}
