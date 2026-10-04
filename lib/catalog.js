/**
 * The Aliyun DashScope (Bailian) catalog this plugin ships.
 *
 * This file does two jobs, and the split is the point:
 *
 * - **Fallback membership.** {@link ./discovery.js} asks the configured endpoint
 *   which models it serves. Until that answer arrives — no credential stored
 *   yet, an endpoint that serves no listing, a network that cannot reach it —
 *   these entries are the whole route, so the picker is never empty.
 * - **Metadata.** A listing discloses ids and nothing else, and the harness
 *   trusts `contextWindow` when it decides to compact history. An id named here
 *   carries the real capacities; an id discovered and *not* named here gets the
 *   conservative defaults from configuration, because an obviously generic
 *   capacity beats an invented precise one.
 *
 * It is plain data on purpose. {@link ./models.js} turns each entry into the
 * pi-ai model descriptor the adapter dispatches with, filling in the route,
 * endpoint, protocol, and compatibility switches from configuration — so an
 * entry here states only what is true of the *model*, never of the deployment.
 *
 * These are the models this route is used with day to day. Verify the capacities
 * against your own endpoint when you upgrade; a wrong `contextWindow` is the
 * failure that hurts.
 */

/** Route name every request selects with `GenerateOptions.provider`. */
export const ROUTE = 'aliyun'

/** Label shown by provider selectors. */
export const DISPLAY_NAME = 'Aliyun DashScope'

/** Mainland-China DashScope endpoint, OpenAI-compatible mode. */
export const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

/** International Model Studio endpoint. */
export const INTL_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'

/**
 * The shape of a Bailian *workspace* endpoint — the per-workspace host the
 * console hands out, and the spelling most keys are issued against.
 *
 * An example to recognize, not a default this package can ship: the workspace id
 * is the deployment's own.
 */
export const WORKSPACE_BASE_URL_EXAMPLE = 'https://llm-<workspace-id>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'

/** Credential reference the route resolves through the harness credential seam. */
export const DEFAULT_API_KEY_ENV = 'ALIYUN_API_KEY'

/**
 * Wire compatibility for Aliyun's OpenAI-compatible endpoint — the route's
 * default, and what every discovered model gets.
 *
 * `thinkingFormat: "qwen"` is the load-bearing switch: Aliyun turns thinking on
 * with a boolean `enable_thinking`, and a model that takes one accepts a
 * `reasoning_effort` beside it. `supportsReasoningEffort: false` is the default
 * because discovery advertises whatever a workspace lists: an unknown model's
 * levels are a guess, and this endpoint answers an effort it does not recognize
 * with a 400. The three shipped entries below override that switch for
 * themselves — their endpoint behaviour has been checked — so their levels
 * travel for real while everything discovered keeps the boolean. The remaining
 * switches describe what the endpoint does not implement, so the request does
 * not carry fields it would refuse.
 */
export const QWEN_COMPAT = Object.freeze({
  thinkingFormat: 'qwen',
  supportsReasoningEffort: false,
  supportsDeveloperRole: false,
  supportsStore: false,
  supportsStrictMode: true,
})

/**
 * What a discovered model gets when no entry below names it.
 *
 * Context is conservative on purpose: compacting early costs tokens, compacting
 * late costs the request. Output sits comfortably under every cap this endpoint
 * publishes, so a request is never refused for asking for more than a model
 * allows.
 */
export const DISCOVERY_DEFAULTS = Object.freeze({
  contextWindow: 131_072,
  maxTokens: 32_768,
  input: Object.freeze(['text']),
})

/** How long a listing stays fresh before a read asks the endpoint again. */
export const DISCOVERY_TTL_MS = 600_000

/** Longest a cold or stale model-list read waits before answering from what it has. */
export const DISCOVERY_WAIT_MS = 2_000

/**
 * The chat families this route advertises by default, as case-insensitive
 * regular expressions.
 *
 * A DashScope listing discloses `id`, `object`, `created`, and `owned_by` — no
 * modality, no task type — so what an id *is* can only be read from its name.
 * That matters because a workspace endpoint lists everything the account can
 * reach: speech synthesis, speech recognition, image generation, embeddings,
 * rerankers, realtime duplex models, and every legacy generation back to
 * `qwen-7b-chat`. Advertising all of it makes the picker unusable and offers
 * models that cannot answer a chat request at all.
 *
 * The patterns are anchored, which is also what drops vendor-prefixed aliases
 * (`ZHIPU/GLM-5.3`, `vanchin/deepseek-v4.1-flash`) whose canonical id is already
 * matched — the two prefixed exceptions are families with no canonical spelling
 * on this endpoint.
 *
 * This is a *default*, not a rule. `discovery.filter: all` advertises the whole
 * listing, `discovery.include` adds families, `discovery.exclude` drops ids, and
 * an id named in `models` is advertised whatever these say.
 */
export const CHAT_MODEL_PATTERNS = Object.freeze([
  '^qwen3\\.8-(max|flash|omni-flash)$',
  '^qwen3\\.7-(max|plus|flash)$',
  '^qwen3\\.6-(plus|flash)$',
  '^qwen3\\.5-(plus|flash|omni-plus|omni-flash)$',
  // Open-weight releases carry their size in the id, which is how they are told
  // apart from the hosted aliases of the same generation.
  '^qwen3\\.[5-8]-\\d+b(-a\\d+b)?$',
  '^qwen3-(max|omni-flash)$',
  '^qwen3-coder-(plus|flash)$',
  '^deepseek-(v4\\.1-flash|v4-pro|v4-flash|v3(\\.[12])?|r1)$',
  '^glm-(4\\.7|5(\\.\\d+)?(-prime)?)$',
  '^kimi-k[23](\\.\\d+)?(-code|-thinking)?$',
  '^MiniMax-M[23](\\.\\d+)?$',
  '^stepfun/step-[0-9.]+(-flash)?$',
  '^xiaomi/mimo-[a-z0-9.]+$',
])

/**
 * Names to drop even when an include pattern matched, because these words are
 * how this endpoint spells "not a plain chat completion model": a snapshot of a
 * model this list already carries, an unreleased preview, or a streaming-first
 * variant.
 */
export const NON_CHAT_MODEL_PATTERNS = Object.freeze([
  '-realtime$',
  '-preview$',
  '-\\d{4}-\\d{2}-\\d{2}$',
  'embedding',
  'rerank',
  '-highspeed$',
  '-flashx$',
])

/**
 * One shipped model.
 *
 * @typedef {object} AliyunModel
 * @property {string} id - request id, and the id the harness records.
 * @property {string} name - display name for selectors.
 * @property {number} contextWindow - total tokens the model accepts.
 * @property {number} maxTokens - output cap for one response.
 * @property {string[]} input - accepted modalities, `text` and/or `image`.
 * @property {boolean} reasoning - whether the model can think.
 * @property {Record<string, string | null>} [thinkingLevelMap] - selectable
 *   thinking levels and the wire spelling each one sends. The base levels
 *   (`off` through `high`) are offered unless mapped to `null`, so `off: null`
 *   is how a model that must think refuses to be turned off; `xhigh` and `max`
 *   are offered only when named. This endpoint takes a boolean rather than an
 *   effort, so on a model that keeps the route's switches what the map really
 *   decides is the *set* of levels a selector offers.
 * @property {Record<string, unknown>} [compat] - wire switches for this model
 *   alone, merged over the route's. Absent keeps the route's switches, which is
 *   what every discovered entry gets.
 */

/** @type {readonly AliyunModel[]} */
export const FALLBACK_MODELS = Object.freeze([
  {
    id: 'qwen3.8-max',
    name: 'Qwen3.8 Max',
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    input: ['text', 'image'],
    reasoning: true,
    // The endpoint's own 400 lists the vocabulary it takes for this model —
    // none, minimal, low, medium, high, xhigh, max, with no `ultra` — so every
    // level pi-ai can name is a spelling this endpoint accepts. Reasoning
    // volume measured flat across them, so the levels are accepted and distinct
    // names rather than a proven ladder.
    thinkingLevelMap: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    compat: { supportsReasoningEffort: true },
  },
  {
    // Aliyun publishes 384K output for this model, and the Aliyun catalog inside
    // the pinned pi-ai carries the same figure.
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    input: ['text', 'image'],
    reasoning: true,
    // Same vocabulary as Qwen's plus `ultra`, for which pi-ai has no level
    // name: that is the one value the endpoint accepts that no map can reach.
    // This is also the model where the ladder is visible — measured reasoning
    // tokens run ~370 for low/high/xhigh and ~700-900 for max/ultra.
    thinkingLevelMap: { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    compat: { supportsReasoningEffort: true },
  },
  {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    input: ['text'],
    reasoning: true,
    // The strictest of the three, in both directions: `enable_thinking` is
    // restricted to true, and its effort enum is only low, high, max. Every
    // other level is mapped to `null` rather than left out, because pi-ai
    // offers each base level unless a map withholds it — so omission would put
    // a level in the selector that this endpoint answers with a 400. Measured
    // reasoning tokens rise with the level here (low 102, high 164, max 832).
    thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' },
    compat: { supportsReasoningEffort: true },
  },
])
