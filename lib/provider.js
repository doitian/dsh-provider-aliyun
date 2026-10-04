/**
 * Build the pi-ai `Provider` the adapter registers for this route.
 *
 * The shape is pi-ai's own provider interface: an id, an endpoint, an auth
 * descriptor, and the protocol implementation every model on the route
 * dispatches through. It mirrors what `@deepseek-ai/dsh-llm-pi-ai` constructs
 * for a route pi-ai ships no catalog for.
 */

/**
 * Api-key auth for a route the harness authenticates itself.
 *
 * The harness resolves the route's credential reference before the request
 * enters pi-ai and passes the key as the stream's `apiKey` option, which pi-ai
 * treats as the highest-priority override. This descriptor is therefore only
 * the fallback pi-ai consults when that option is absent — it deliberately
 * reports no key rather than inventing one, so a missing credential stays the
 * harness's loud failure instead of becoming a confusing upstream 401.
 *
 * @param {string} name - label used as the resolution's status name.
 * @returns {object} pi-ai api-key auth.
 */
function harnessApiKeyAuth(name) {
  return {
    name,
    resolve: ({ credential }) => Promise.resolve({
      auth: credential?.key === undefined ? {} : { apiKey: credential.key },
    }),
  }
}

/**
 * Construct one static, single-protocol provider.
 *
 * @param {object} input - route identity and dispatch.
 * @param {string} input.id - route name.
 * @param {string} input.name - display name.
 * @param {string} input.baseUrl - endpoint every model on the route uses.
 * @param {object[]} input.models - pi-ai model descriptors.
 * @param {object} input.api - pi-ai protocol implementation.
 * @returns {object} the pi-ai provider.
 */
export function createPiProvider({ id, name, baseUrl, models, api }) {
  return {
    id,
    name,
    baseUrl,
    auth: { apiKey: harnessApiKeyAuth(name) },
    getModels: () => models,
    stream: (model, context, options) => api.stream(model, context, options),
    streamSimple: (model, context, options) => api.streamSimple(model, context, options),
  }
}
