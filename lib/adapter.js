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
 * Neither are the route *facts*. The configuration fields are volatile, so the
 * Models page can move the endpoint, the credential reference, or the display
 * name under a mounted plugin rather than remounting it; `facts` is read on
 * every rebuild for exactly that reason. A rebuild happens only when the facts
 * or the catalog actually moved, because the adapter memoizes by map identity
 * and rebuilding on every read would defeat that.
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
 * Everything is computed from the facts handed in, which are the route's
 * *current* configuration — the caller reads them fresh for each rebuild.
 *
 * @param {object} options - route facts.
 * @param {string} options.displayName - label for selectors.
 * @param {string} options.apiKeyEnv - credential reference to resolve per request.
 * @param {string} options.baseURL - endpoint for every model on the route.
 * @param {readonly import('./catalog.js').AliyunModel[]} options.models - the advertised catalog.
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
 * @param {() => { displayName: string, apiKeyEnv: string, baseURL: string, reasoning?: string, headers?: Record<string, string> }} options.facts - the route's current configuration, read on every rebuild.
 * @param {readonly import('./catalog.js').AliyunModel[]} options.models - the catalog to advertise first.
 * @param {(provider: string, profile: object) => Promise<string | undefined>} options.resolveApiKey - credential resolver.
 * @param {() => object | undefined} [options.resolveAttachments] - durable attachment service accessor.
 * @param {(attachments: object, ref: object) => unknown} [options.resolveImageAccess] - image access resolver.
 * @param {(event: object) => void} [options.onReplayDegrade] - replay degradation reporter.
 * @param {() => void} [options.onRead] - called before every operation reads the profile map.
 * @param {() => Promise<void>} [options.settle] - awaited before a model list is answered.
 * @returns {{ adapter: PiAiAdapter, setCatalog: (models: readonly import('./catalog.js').AliyunModel[]) => void }} the adapter to register, and the way to move its catalog.
 */
export function createAliyunAdapter(options) {
  /** The entries the route advertises; swapped wholesale by discovery. */
  let advertised = options.models
  /**
   * Bumped by every catalog swap. Part of the rebuild signature rather than
   * compared by value, because the catalog is the one input big enough that
   * comparing it on every read would cost more than rebuilding a profile map.
   */
  let catalogVersion = 0
  /** The signature the current `profiles` was built from. */
  let builtFrom
  /** The profile map the adapter memoizes by identity; a rebuild replaces it. */
  let profiles

  /**
   * The profile map for the configuration as it stands.
   *
   * The adapter compares this map by identity to decide whether its snapshot is
   * still current, so the map must be replaced exactly when something moved —
   * rebuilding unconditionally would invalidate the snapshot on every read and
   * make each operation re-derive its whole model list.
   *
   * @returns {Map<string, object>} one route's profiles.
   */
  const currentProfiles = () => {
    const facts = options.facts()
    const signature = [
      catalogVersion,
      facts.displayName,
      facts.apiKeyEnv,
      facts.baseURL,
      facts.reasoning ?? '',
      JSON.stringify(facts.headers ?? null),
    ].join('\u0000')
    if (signature !== builtFrom) {
      builtFrom = signature
      profiles = new Map([[ROUTE, buildAliyunProfile({ ...facts, models: advertised })]])
    }
    return profiles
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
      return currentProfiles()
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
      advertised = models
      catalogVersion += 1
    },
  }
}
