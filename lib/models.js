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
 * Compile configured pattern sources, reporting the ones that are not regular
 * expressions instead of failing the mount.
 *
 * A typo in a profile should cost that one pattern, not the route: the rest of
 * the filter still does its job, and the diagnostic names the pattern to fix.
 *
 * @param {readonly string[]} sources - pattern sources from configuration.
 * @param {(source: string, error: Error) => void} [onInvalid] - called once per source that will not compile.
 * @returns {RegExp[]} the compiled patterns, case-insensitive.
 */
export function compilePatterns(sources, onInvalid) {
  const patterns = []
  // A missing list means "no patterns of this kind", which is what an explicit
  // empty list means too; only a source that will not compile is reported.
  for (const source of sources ?? []) {
    try {
      patterns.push(new RegExp(source, 'i'))
    } catch (error) {
      onInvalid?.(source, error)
    }
  }
  return patterns
}

/**
 * Choose which of the endpoint's ids this route advertises.
 *
 * A listing is a workspace's whole catalogue, so membership needs one more
 * decision than "what did the endpoint say": which of those ids a *chat route*
 * can serve. Two independent signals answer it, and either is enough: a pattern
 * the profile configures, and the metadata snapshot, which states outright
 * whether a model answers with text.
 *
 * Two rules keep the filter from hiding something the user asked for:
 *
 * - An id named in `models` (`pinned`) is always advertised, whatever the
 *   patterns and the snapshot say. Naming a model is a stronger statement than
 *   either.
 * - `mode: 'all'` skips the include half entirely and keeps only exclusions,
 *   which is how a profile opts back into the raw listing.
 *
 * Endpoint order is preserved: the picker shows the models in the order the
 * endpoint listed them.
 *
 * @param {readonly string[]} ids - the endpoint's ids, in endpoint order.
 * @param {object} [options] - the filter.
 * @param {'chat' | 'patterns' | 'all'} [options.mode] - which signals admit an id.
 * @param {readonly RegExp[]} [options.include] - families to keep in either gated mode.
 * @param {readonly RegExp[]} [options.exclude] - ids to drop in every mode.
 * @param {readonly string[]} [options.pinned] - ids that always survive.
 * @param {(id: string) => boolean} [options.known] - whether the metadata snapshot knows this id as a text-answering model.
 * @returns {string[]} the ids to advertise.
 */
export function selectIds(ids, { mode = 'chat', include = [], exclude = [], pinned = [], known } = {}) {
  const always = new Set(pinned)
  return ids.filter((id) => {
    if (always.has(id)) return true
    if (exclude.some((pattern) => pattern.test(id))) return false
    if (mode === 'all') return true
    if (include.some((pattern) => pattern.test(id))) return true
    // `patterns` is the tight mode: only what the profile lists, so a picker can
    // be narrowed without the registry quietly widening it again.
    return mode === 'chat' && known?.(id) === true
  })
}

/**
 * Spell an id the one way both sides can agree on.
 *
 * Registries and endpoints disagree about dots: models.dev publishes
 * `qwen2-5-32b-instruct` where an endpoint answers `qwen2.5-32b-instruct`, and
 * the same model appears under both spellings. Case is ignored for the same
 * reason (`MiniMax-M2.5` beside `MiniMax/MiniMax-M2.5`).
 *
 * @param {string} id - a model id from either side.
 * @returns {string} the comparable spelling.
 */
function normalizeId(id) {
  return id.toLowerCase().replace(/\./g, '-')
}

/**
 * Index a metadata snapshot for lookup by the ids an endpoint answers with.
 *
 * A vendor-prefixed id (`vanchin/deepseek-v4.1-flash`) falls back to its last
 * path segment, because the registry publishes the canonical id and the
 * endpoint often lists both spellings of the same model.
 *
 * @param {object} snapshot - the generated snapshot, as `lib/metadata.json` holds it.
 * @returns {{ facts: (id: string) => object | undefined, knows: (id: string) => boolean, size: number }} the lookup.
 */
export function createMetadataIndex(snapshot) {
  const models = snapshot?.models ?? {}
  const byId = new Map()
  for (const [id, facts] of Object.entries(models)) byId.set(normalizeId(id), facts)
  const facts = (id) => {
    const key = normalizeId(id)
    return byId.get(key) ?? byId.get(key.slice(key.lastIndexOf('/') + 1))
  }
  // Membership asks a stricter question than facts do: an alias resolving to the
  // same model is worth facts, but admitting it would advertise one model twice,
  // once under a vendor prefix that may route somewhere else entirely.
  const knows = (id) => byId.has(normalizeId(id))
  return { facts, knows, size: byId.size }
}

/**
 * Resolve the entries one route advertises right now.
 *
 * The endpoint answers *membership* — it is the only authority on what it
 * serves — while this package answers *facts*. Both layers matter: an id the
 * fallback catalog names keeps its verified capacities, and an id only the
 * endpoint knows is advertised with whatever facts the metadata snapshot holds,
 * or with the configured conservative defaults when even that is silent —
 * rather than being dropped, because a model the user can select and correct is
 * worth more than one this package silently hides.
 *
 * Membership follows the listing exactly, including removals: a model the
 * endpoint stops serving stops being selectable. `ids === undefined` means no
 * listing has ever arrived, which is the fallback catalog's whole job.
 *
 * @param {object} input - the layers, most authoritative first.
 * @param {readonly string[] | undefined} input.ids - ids already selected by {@link selectIds}, or `undefined` before any listing.
 * @param {readonly import('./catalog.js').AliyunModel[]} input.fallback - shipped entries, which also carry metadata.
 * @param {{ contextWindow: number, maxTokens: number, input: readonly string[] }} input.defaults - capacities for an id neither layer names.
 * @param {{ facts: (id: string) => object | undefined }} [input.metadata] - the generated snapshot's lookup.
 * @returns {import('./catalog.js').AliyunModel[]} the entries to advertise, in endpoint order.
 */
export function mergeCatalog({ ids, fallback, defaults, metadata }) {
  if (ids === undefined) return [...fallback]
  const pinned = new Map(fallback.map((entry) => [entry.id, entry]))
  return ids.map((id) => {
    const written = pinned.get(id)
    if (written !== undefined) return written
    const facts = metadata?.facts(id)
    if (facts === undefined) {
      return {
        id,
        name: id,
        contextWindow: defaults.contextWindow,
        maxTokens: defaults.maxTokens,
        input: [...defaults.input],
        // Nothing is known about this model's thinking, and claiming it can
        // think would offer levels the endpoint may refuse. Configuration can
        // say so.
        reasoning: false,
      }
    }
    const positive = (value, fallbackValue) => (Number.isInteger(value) && value > 0 ? value : fallbackValue)
    const reasoning = facts.reasoning === true
    return {
      id,
      name: typeof facts.name === 'string' && facts.name.length > 0 ? facts.name : id,
      contextWindow: positive(facts.contextWindow, defaults.contextWindow),
      maxTokens: positive(facts.maxTokens, defaults.maxTokens),
      input: Array.isArray(facts.input) && facts.input.length > 0 ? [...facts.input] : [...defaults.input],
      reasoning,
      // The snapshot states that a model thinks, not how its levels are spelled.
      // This endpoint takes a boolean, so what the map decides is which levels a
      // selector offers — and these are the levels the shipped entries use.
      ...reasoning ? { thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' } } : {},
    }
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
      // The route's switches describe the endpoint; an entry may override them
      // for that model alone when this endpoint treats it differently — a model
      // whose levels travel as `reasoning_effort` beside the boolean, for
      // instance. A model naming no override keeps the route's switches, which
      // is what every discovered model gets.
      compat: { ...compat, ...entry.compat },
    }
  })
}
