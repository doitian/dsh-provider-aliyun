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
 * Wire compatibility for Aliyun's OpenAI-compatible endpoint.
 *
 * `thinkingFormat: "qwen"` is the load-bearing switch: Aliyun turns thinking on
 * with a boolean `enable_thinking` rather than a reasoning-effort field, and
 * that is what pi-ai's `qwen` format sends. `supportsReasoningEffort: false`
 * keeps an effort value off the wire, where this endpoint would reject it,
 * while the selected level still drives the boolean. The remaining switches
 * describe what the endpoint does not implement, so the request does not carry
 * fields it would refuse.
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
 * One shipped model.
 *
 * @typedef {object} AliyunModel
 * @property {string} id - request id, and the id the harness records.
 * @property {string} name - display name for selectors.
 * @property {number} contextWindow - total tokens the model accepts.
 * @property {number} maxTokens - output cap for one response.
 * @property {string[]} input - accepted modalities, `text` and/or `image`.
 * @property {boolean} reasoning - whether the model can think.
 * @property {Record<string, string>} [thinkingLevelMap] - selectable thinking
 *   levels and the wire spelling each one sends. A level left out is not
 *   offered; `off` is offered unless it is named here. This endpoint takes a
 *   boolean rather than an effort, so what the map really decides is the *set*
 *   of levels a selector offers.
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
    thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
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
    thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
  },
  {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    input: ['text'],
    reasoning: true,
    thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
  },
])
