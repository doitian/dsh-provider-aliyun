/**
 * The Aliyun DashScope (Bailian) model catalog this plugin ships.
 *
 * This file is the whole point of the package: the model list lives here, in
 * the plugin, so `pnpm update` refreshes it. Nothing about it needs to be
 * written into a profile, and no profile patch can shadow it.
 *
 * It is plain data on purpose. {@link ./models.js} turns each entry into the
 * pi-ai model descriptor the adapter dispatches with, filling in the route,
 * endpoint, protocol, and compatibility switches from configuration — so an
 * entry here states only what is true of the *model*, never of the deployment.
 *
 * The entries mirror the facts Aliyun publishes for its Qwen lineup. Verify
 * them against your endpoint when you upgrade; a wrong `contextWindow` is the
 * failure that hurts, because the harness trusts it when it compacts history.
 */

/** Route name every request selects with `GenerateOptions.provider`. */
export const ROUTE = 'aliyun'

/** Label shown by provider selectors. */
export const DISPLAY_NAME = 'Aliyun DashScope'

/** Mainland-China DashScope endpoint, OpenAI-compatible mode. */
export const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

/** International Model Studio endpoint. */
export const INTL_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'

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
 *   offered; `off` is offered unless it is named here.
 */

/** @type {readonly AliyunModel[]} */
export const ALIYUN_MODELS = Object.freeze([
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
    id: 'qwen3.8-flash',
    name: 'Qwen3.8 Flash',
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    input: ['text', 'image'],
    reasoning: true,
    thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
  },
  {
    id: 'qwen3.7-max',
    name: 'Qwen3.7 Max',
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    input: ['text'],
    reasoning: true,
    thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
  },
  {
    id: 'qwen3.7-plus',
    name: 'Qwen3.7 Plus',
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    input: ['text', 'image'],
    reasoning: true,
    thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
  },
  {
    id: 'qwen3.6-plus',
    name: 'Qwen3.6 Plus',
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    input: ['text', 'image'],
    reasoning: true,
    thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
  },
  {
    id: 'qwen3.6-flash',
    name: 'Qwen3.6 Flash',
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    input: ['text', 'image'],
    reasoning: true,
    thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
  },
])
