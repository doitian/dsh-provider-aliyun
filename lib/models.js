/**
 * Turn catalog entries into the pi-ai model descriptors the adapter dispatches
 * with, and decide which entries a route advertises right now.
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
 * Resolve the entries one route advertises right now.
 *
 * The endpoint answers *membership* — it is the only authority on what it
 * serves — while this package answers *facts*. Both layers matter: an id the
 * fallback catalog names keeps its verified capacities, and an id only the
 * endpoint knows is advertised with the configured conservative defaults rather
 * than being dropped, because a model the user can select and correct is worth
 * more than one this package silently hides.
 *
 * Membership follows the listing exactly, including removals: a model the
 * endpoint stops serving stops being selectable. `ids === undefined` means no
 * listing has ever arrived, which is the fallback catalog's whole job.
 *
 * @param {object} input - the two layers.
 * @param {readonly string[] | undefined} input.ids - endpoint order, or `undefined` before any listing.
 * @param {readonly import('./catalog.js').AliyunModel[]} input.fallback - shipped entries, which also carry metadata.
 * @param {{ contextWindow: number, maxTokens: number, input: readonly string[] }} input.defaults - capacities for an id the fallback does not name.
 * @returns {import('./catalog.js').AliyunModel[]} the entries to advertise, in endpoint order.
 */
export function mergeCatalog({ ids, fallback, defaults }) {
  if (ids === undefined) return [...fallback]
  const known = new Map(fallback.map((entry) => [entry.id, entry]))
  return ids.map((id) => known.get(id) ?? {
    id,
    name: id,
    contextWindow: defaults.contextWindow,
    maxTokens: defaults.maxTokens,
    input: [...defaults.input],
    // Nothing is known about this model's thinking, and claiming it can think
    // would offer levels the endpoint may refuse. Configuration can say so.
    reasoning: false,
  })
}

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
