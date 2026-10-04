/**
 * Turn shipped catalog entries into the pi-ai model descriptors the adapter
 * dispatches with.
 *
 * A catalog entry states only model facts; everything deployment-specific —
 * the route it belongs to, the endpoint, the protocol, the compatibility
 * switches — is supplied here from configuration. That split is what lets the
 * catalog stay a plain data file that a script or a human can update without
 * knowing anything about pi-ai.
 */

/** Aliyun bills per token; the harness's cost surfaces are not fed from here. */
const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

/**
 * Materialize one route's models.
 *
 * @param {object} input - catalog and route facts.
 * @param {readonly import('./catalog.js').AliyunModel[]} input.catalog - shipped entries.
 * @param {string} input.provider - route name every model is stamped with.
 * @param {string} input.baseUrl - endpoint every model is stamped with.
 * @param {Record<string, unknown>} input.compat - compatibility switches to copy onto each model.
 * @returns {object[]} pi-ai model descriptors.
 */
export function materializeModels({ catalog, provider, baseUrl, compat }) {
  return catalog.map((entry) => {
    const reasoning = entry.reasoning === true
    return {
      id: entry.id,
      name: entry.name,
      api: 'openai-completions',
      provider,
      baseUrl,
      reasoning,
      input: [...entry.input],
      cost: { ...NO_COST },
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      // Only a thinking model carries a level map. pi-ai reads an absent map as
      // "no levels beyond off", and a model declared non-reasoning must not
      // advertise levels a selector would then offer.
      ...reasoning && entry.thinkingLevelMap !== undefined
        ? { thinkingLevelMap: { ...entry.thinkingLevelMap } }
        : {},
      compat: { ...compat },
    }
  })
}
