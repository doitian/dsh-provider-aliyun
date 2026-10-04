/**
 * Drive the browser half without a browser.
 *
 * `lib/client.js` is hand-written in the module loader's format, so the only
 * thing that can check it is loading it the way the page does: register the
 * factory, materialize it, and then drive the plugin it hands back. The card
 * renders with a stub `createElement` — it uses no hooks of its own, reading
 * state through the selector hook its own registration injects — which is what
 * makes the rendered tree assertable here.
 *
 * What this covers is the card's own decisions: which fields it puts on screen,
 * what it refuses locally, the ordering of the two writes, and what a refused
 * write leaves behind. `scripts/validate.mjs` covers the registration itself.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

import { DEFAULT_BASE_URL } from '../lib/catalog.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Load the browser half the way the page does and materialize its factory. */
function loadClientPlugin() {
  const registrations = []
  const sandbox = { window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }, console }
  runInNewContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), sandbox, { filename: 'lib/client.js' })
  assert.equal(registrations.length, 1)
  // The card builds elements with React.createElement and nothing else, so the
  // stub only has to keep the tree.
  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    }),
  }
  return registrations[0].factory((specifier) => {
    assert.equal(specifier, 'react')
    return React
  })
}

/** Resolve every function element so the tree is plain data. */
function render(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(render).filter((child) => child !== null)
  if (typeof node === 'string' || typeof node === 'number') return { type: '#text', props: {}, children: [String(node)] }
  if (typeof node.type === 'function') return render(node.type(node.props))
  return { type: node.type, props: node.props, children: (node.children ?? []).map(render).filter((child) => child !== null) }
}

/**
 * Detach a value the bundle produced.
 *
 * The bundle runs in its own realm, so the arrays and objects it hands back carry
 * that realm's prototypes and `assert.deepStrictEqual` refuses them as "same
 * structure but not reference-equal". Comparing serialized copies is the honest
 * way to assert on them.
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

/** Every node in a rendered tree, depth first. */
function walk(node, out = []) {
  if (node === null) return out
  out.push(node)
  for (const child of node.children ?? []) walk(child, out)
  return out
}

/** The text content of a rendered subtree. */
function textOf(node) {
  return walk(node)
    .filter((child) => child.type === '#text')
    .map((child) => child.children[0])
    .join(' ')
}

/** The first node with this element type and id. */
function byId(tree, id) {
  return walk(tree).find((node) => node.props?.id === id)
}

/**
 * A stand-in for `ctx.configForms.get(ns)`, which is the accepted section plus
 * its revision and the revision-fenced write.
 */
function createScope(options = {}) {
  const listeners = new Set()
  const mutations = []
  // `refuse: n` fails the next n writes, which is how a lost revision race — the
  // host refuses a stale fence and then accepts the retry — is reproduced.
  let refusals = options.refuse === true ? Infinity : (options.refuse ?? 0)
  const state = {
    status: 'ready',
    writable: true,
    revision: 7,
    value: {
      baseURL: DEFAULT_BASE_URL,
      apiKeyEnv: 'ALIYUN_API_KEY',
      models: [{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000, maxTokens: 100, input: ['text'], reasoning: false }],
    },
    base: {},
    user: {},
    ...(options.state ?? {}),
  }
  return {
    state,
    mutations,
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate(ops, revision) {
      mutations.push({ ops, revision })
      if (refusals > 0) {
        refusals -= 1
        return Promise.resolve(false)
      }
      for (const op of ops) {
        if (op.op === 'set') {
          state.value = { ...state.value, [op.path[0]]: op.value }
          state.user = { ...state.user, [op.path[0]]: op.value }
        } else {
          const value = { ...state.value }
          delete value[op.path[0]]
          state.value = value
          const user = { ...state.user }
          delete user[op.path[0]]
          state.user = user
        }
      }
      for (const listener of [...listeners]) listener()
      return Promise.resolve(true)
    },
  }
}

/** Mount the browser half over a stub context and return the card's handles. */
function mount(options = {}) {
  const plugin = loadClientPlugin()
  const scope = createScope(options)
  const dictionaries = new Map()
  const credentialWrites = []
  const credentialRefs = []
  let registration
  const credentialInfo = options.credentialInfo ?? { configured: true }

  const ctx = {
    effect: (register) => {
      register()
      return () => {}
    },
    locale: {
      register: (ns, copy) => {
        dictionaries.set(ns, copy)
        return () => {}
      },
      bind: (ns) => (key) => {
        const copy = dictionaries.get(ns) ?? {}
        return copy.en?.[key] ?? key
      },
    },
    configForms: {
      get: () => scope,
      whileServed: (namespaces, register) => {
        assert.deepEqual(plain(namespaces), ['llm-aliyun'])
        return register(new Set(namespaces))
      },
    },
    slots: {
      inject: (slot, register) => {
        assert.equal(slot, 'settings.models.provider-card')
        return register()
      },
      register: (spec, component) => {
        registration = { spec, component }
        return () => {}
      },
    },
    remote: {
      credentials: {
        describe: async (refs) => {
          credentialRefs.push(...refs)
          return { ok: true, value: Object.fromEntries(refs.map((ref) => [ref, credentialInfo])) }
        },
        set: async (ref, value) => {
          credentialWrites.push({ ref, value })
          if (options.credentialRefuse === true) {
            return { ok: false, error: { code: 'credential-rejected', message: 'refused by the credential provider' } }
          }
          return { ok: true, value: { configured: true } }
        },
      },
    },
  }

  plugin.apply(ctx)
  const face = registration.spec.inject()
  const renderCard = () => render(registration.component({
    t: ctx.locale.bind(registration.spec.locale),
    useAliyunCard: (selector) => selector(face.hooks.aliyunCard.getSnapshot()),
    edit: face.edit,
    resetField: face.resetField,
    editKey: face.editKey,
    discard: face.discard,
    save: face.save,
  }))

  return { plugin, scope, registration, face, renderCard, credentialWrites, credentialRefs, dictionaries }
}

test('the browser half registers one keyed card on the Models page', () => {
  const { plugin, registration } = mount()
  assert.deepEqual(plain(plugin.inject), ['slots', 'locale', 'configForms', 'remote.credentials'])
  assert.equal(registration.spec.name, 'settings.models.provider-card')
  assert.equal(registration.spec.key, 'llm-aliyun', 'a keyed slot dispatches by settings namespace')
  assert.equal(registration.spec.locale, 'settings.aliyun')
  assert.equal(typeof registration.component, 'function')
})

test('the card shows the endpoint, a write-only key, and the model overrides', async () => {
  const { renderCard, credentialRefs } = mount()
  await Promise.resolve()
  const tree = renderCard()

  const endpoint = byId(tree, 'dsh-aliyun-endpoint')
  assert.equal(endpoint.type, 'input')
  assert.equal(endpoint.props.type, 'text')
  assert.equal(endpoint.props.value, DEFAULT_BASE_URL)

  // The key is write-only across the wire, so the control starts blank and only
  // reports whether a stored one exists.
  const key = byId(tree, 'dsh-aliyun-key')
  assert.equal(key.props.type, 'password')
  assert.equal(key.props.value, '')
  assert.equal(key.props.autoComplete, 'new-password')

  const models = byId(tree, 'dsh-aliyun-models')
  assert.equal(models.type, 'textarea')
  assert.deepEqual(JSON.parse(models.props.value).map((entry) => entry.id), ['glm-5.3'])

  assert.deepEqual(credentialRefs, ['ALIYUN_API_KEY'], 'the reference comes from the live profile')
})

test('a bad model draft is refused locally and disables the save', () => {
  const { face, renderCard } = mount()
  face.edit('models', '{ not json')

  const tree = renderCard()
  assert.equal(byId(tree, 'dsh-aliyun-models').props['aria-invalid'], true)
  assert.match(textOf(tree), /Not valid JSON/)
  assert.equal(findSave(tree).props.disabled, true)
})

/** The Save button, identified by its copy rather than by position. */
function findSave(tree) {
  return walk(tree).find((node) => node.type === 'button' && textOf(node) === 'Save')
}

test('a duplicate model id is refused, because the host would refuse it too', () => {
  const { face, renderCard } = mount()
  face.edit('models', JSON.stringify([
    { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000, maxTokens: 100, input: ['text'], reasoning: false },
    { id: 'glm-5.3', name: 'Again', contextWindow: 1_000, maxTokens: 100, input: ['text'], reasoning: false },
  ]))
  assert.match(textOf(renderCard()), /repeats the id/)
})

test('a malformed key is refused before any write', () => {
  const { face, renderCard, credentialWrites } = mount()
  face.editKey('ALIYUN_API_KEY=sk-test')
  const tree = renderCard()
  assert.equal(byId(tree, 'dsh-aliyun-key').props['aria-invalid'], true)
  assert.equal(findSave(tree).props.disabled, true)
  face.save()
  assert.deepEqual(credentialWrites, [])
})

test('a save writes the section first, then the credential, then clears the drafts', async () => {
  const { face, scope, credentialWrites, renderCard } = mount()
  face.edit('baseURL', 'https://moved.example/v1')
  face.editKey('sk-test')
  await face.save()

  assert.deepEqual(plain(scope.mutations), [{
    ops: [{ op: 'set', path: ['baseURL'], value: 'https://moved.example/v1' }],
    revision: 7,
  }])
  assert.deepEqual(credentialWrites, [{ ref: 'ALIYUN_API_KEY', value: 'sk-test' }])

  // Both halves landed, so nothing is left staged and the card says so.
  const tree = renderCard()
  assert.equal(byId(tree, 'dsh-aliyun-endpoint').props.value, 'https://moved.example/v1')
  assert.equal(byId(tree, 'dsh-aliyun-key').props.value, '')
  assert.match(textOf(tree), /Applied/)
})

test('a cleared field unsets the override rather than writing an empty value', async () => {
  const scopeSeed = { user: { baseURL: 'https://pinned.example/v1' }, value: { baseURL: 'https://pinned.example/v1', apiKeyEnv: 'ALIYUN_API_KEY' } }
  const { face, scope } = mount({ state: scopeSeed })
  face.resetField('baseURL')
  await face.save()
  assert.deepEqual(plain(scope.mutations), [{ ops: [{ op: 'unset', path: ['baseURL'] }], revision: 7 }])
})

test('an empty model draft clears the override instead of failing validation', async () => {
  // **Reset to the shipped catalog** stages an empty draft. Treating that as
  // "not valid JSON" left the field showing an error with the save disabled, so
  // the override could be neither cleared nor corrected — the reset button had
  // no way to complete.
  const { face, scope, renderCard } = mount({
    state: { user: { models: [{ id: 'glm-5.3' }] }, value: { baseURL: DEFAULT_BASE_URL, apiKeyEnv: 'ALIYUN_API_KEY', models: [{ id: 'glm-5.3' }] } },
  })
  face.resetField('models')

  const tree = renderCard()
  assert.equal(byId(tree, 'dsh-aliyun-models').props['aria-invalid'], undefined, 'an empty draft is not invalid')
  assert.equal(findSave(tree).props.disabled, false, 'the reset must be saveable')

  await face.save()
  assert.deepEqual(plain(scope.mutations), [{ ops: [{ op: 'unset', path: ['models'] }], revision: 7 }])
})

test('an empty model draft on a field with no override stages nothing', () => {
  const { face, renderCard } = mount()
  face.resetField('models')
  // Nothing to clear, so the field is valid and the save has nothing to do.
  assert.equal(byId(renderCard(), 'dsh-aliyun-models').props['aria-invalid'], undefined)
  assert.equal(findSave(renderCard()).props.disabled, true)
})

test('a refused write keeps the drafts so they can be corrected', async () => {
  const { face, renderCard } = mount({ refuse: true })
  face.edit('baseURL', 'https://refused.example/v1')
  await face.save()

  const tree = renderCard()
  assert.match(textOf(tree), /did not accept these values/)
  assert.equal(byId(tree, 'dsh-aliyun-endpoint').props.value, 'https://refused.example/v1', 'the draft survives a refusal')
})

test('a lost race is retried once against a fresh fence, not reported as a refusal', async () => {
  // The host rewrites this section for its own writes, so a revision read before
  // that landed is refused as a conflict even though the user's intent is valid.
  const { face, scope, renderCard } = mount({ refuse: 1 })
  face.edit('baseURL', 'https://raced.example/v1')
  await face.save()

  assert.equal(scope.mutations.length, 2, 'the refused attempt is retried')
  assert.equal(scope.mutations[0].revision, 7, 'the first attempt fences on what the card read')
  assert.equal(scope.mutations[1].revision, undefined, 'the retry lets the scope choose its own fence')
  assert.match(textOf(renderCard()), /Applied/)
})

test('a refused key says the settings half landed, and keeps the key for another try', async () => {
  const { face, renderCard, credentialWrites } = mount({ credentialRefuse: true })
  face.edit('baseURL', 'https://moved.example/v1')
  face.editKey('sk-test')
  await face.save()

  assert.equal(credentialWrites.length, 1)
  const tree = renderCard()
  assert.match(textOf(tree), /were applied, but the API key was not stored/)
  assert.equal(byId(tree, 'dsh-aliyun-endpoint').props.value, 'https://moved.example/v1', 'the applied value is current')
  assert.equal(byId(tree, 'dsh-aliyun-key').props.value, 'sk-test', 'the key draft survives for a second attempt')
  assert.equal(findSave(tree).props.disabled, false, 'the retry offers the credential stage alone')
})

test('discard drops every draft', () => {
  const { face, renderCard } = mount()
  face.edit('baseURL', 'https://typed.example/v1')
  face.editKey('sk-typed')
  assert.equal(findSave(renderCard()).props.disabled, false)

  face.discard()
  const tree = renderCard()
  assert.equal(byId(tree, 'dsh-aliyun-endpoint').props.value, DEFAULT_BASE_URL)
  assert.equal(byId(tree, 'dsh-aliyun-key').props.value, '')
  assert.equal(findSave(tree).props.disabled, true)
})

test('a read-only deployment disables every control', () => {
  const { renderCard } = mount({ state: { writable: false } })
  const tree = renderCard()
  assert.equal(byId(tree, 'dsh-aliyun-endpoint').props.disabled, true)
  assert.equal(byId(tree, 'dsh-aliyun-models').props.disabled, true)
  assert.equal(findSave(tree).props.disabled, true)
  assert.match(textOf(tree), /read-only/)
})

test('a namespace the host does not serve renders nothing', () => {
  const { renderCard } = mount({ state: { status: 'unavailable', value: undefined } })
  const tree = renderCard()
  assert.equal(byId(tree, 'dsh-aliyun-endpoint'), undefined)
  assert.match(textOf(tree), /not loaded/)
})
