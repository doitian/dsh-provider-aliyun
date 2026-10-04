# Configuring this plugin from the Models page

Research note. Why the `aliyun` row on **Settings → Models** had no editable
fields, what DSH actually offers a plugin that wants them, and the two routes to
getting the endpoint, the API key, and the model overrides into that tab.

> **Status: the recommended path is implemented.** The volatile `Config`, the
> reactive host half, and the `lib/client.js` card are in the tree; see
> [The Models page](../README.md#the-models-page) for what a user sees. This note
> is kept as the design record — in particular for the measurements below, which
> are the reason the other route was not taken.
>
> One thing the implementation confirmed that the note only inferred: the
> settings edit reaches a mounted plugin through `resolveConfig`, which updates
> the volatile references **in place** and does not remount the entry
> (`dsh-config-editor/lib/index.js:82-83`). Everything derived from the
> configuration therefore had to become a function of it, which is what
> `sync()` in `lib/index.js` and `facts()` in `lib/adapter.js` exist for.

Everything below was read out of the installed harness (`0.2.0-rc.2`, Desktop
`app.asar`) rather than a source checkout. File references are to the extracted
package sources; the decisive lines are quoted.

## The finding in one paragraph

The Models page renders a per-provider editor **only** for the `llm-deepseek`
and `llm-pi-ai` settings namespaces — the layout is a hardcoded two-way branch,
and any other namespace gets a hint and a **disabled** Apply button. So no
configuration surface for this plugin can be reached by making its `Config`
richer. What DSH does offer is a **keyed extension slot**,
`settings.models.provider-card`, declared by exactly that page *for plugins
distributed outside the harness repository*; a plugin that ships a client half
registers into it, keyed by its own settings namespace, and renders inside its
own provider card. Writes go through the settings seam, which requires the
plugin's config fields to be `.volatile()`. Both halves are small, and the
official plugin-development skill ships a four-file template for exactly this
shape.

## What the page does today

`dsh-client-ui-settings-models/lib/client.js`:

```js
/** The editor layout the owning namespace selects. */
function layoutOf(ns) {
  if (ns === "llm-deepseek") return "deepseek";
  if (ns === "llm-pi-ai") return "pi-ai";
  return "unknown";
}
```
— `lib/client.js:1492`

The whole curated editor — API-key input, `baseURL`, and the model list — lives
inside `curatedFields(family)`, whose own comment says an unknown namespace
"renders the hint instead and never reaches this body" (`lib/client.js:1654`).
The consequences for this plugin's namespace:

| Line | What happens for an unknown namespace |
|---|---|
| `:1690` | the API-key `<input>` is inside `curatedFields`, so it is **not rendered** |
| `:1742` | the `baseURL` field is not rendered |
| `:1787` | the model list editor is not rendered |
| `:1813` | a paragraph is rendered instead: "advanced fields live in `cordis.patch.yml` (`llm-aliyun`)" |
| `:1828` | the submit button is `disabled` |

That is precisely what the README already documents at
[Configure the API key](../README.md#configure-the-api-key): the row, its
missing-credential dot, and a hint pointing at `cordis.patch.yml`.

Two facts from the package's own README frame the fix:

- The page "declares two seats for plugins distributed outside this repository
  … `settings.models.provider-card` (keyed) renders inside every card that shows
  a directory row … dispatched with `entryKey = settingsNs`" (`README.md:64`).
- "Undeclared live routes render nowhere" (`README.md:130`) — this plugin *is*
  declared, which is why it has a row at all (`ctx.llm.registerConfigurableProviders`
  in `lib/index.js:220`).

The two seats are declared with the section (`lib/client.js:4059`):

```js
children: {
  "settings.models.provider-card": { kind: "keyed", scope: "root" },
  "settings.models.footer":         { kind: "list",  scope: "root" },
}
```

and rendered per row (`:2150`, `:2215`):

```js
renderSlot("settings.models.provider-card", {
  provider: row.entry,          // ConfigurableProviderView
  configured: row.configured,
  keyConfigured: keyConfiguredOf(row),
}, { entryKey: row.entry.settingsNs })
```

## Mechanism 1 — a volatile `Config` is the price of any GUI write

`@deepseek-ai/dsh-settings` is the service that turns stored user settings into
live plugin configuration. Its constraints, from `dsh-settings/lib/index.js`:

- **The namespace is the Loader entry id.** `write(ns, …)` looks the entry up by
  `row.options.id === ns` (`:501-504`) and takes the schema from
  `entry.fiber.runtime.Config` (`:538-541`). This plugin already exports `Config`
  and already derives `settingsNs` from the entry id (`lib/index.js:127`), so the
  address matches today.
- **Only volatile fields are writable.** `write` refuses outright:
  `Plugin entry "${ns}" has no volatile fields` (`:506`) and
  `Config field "${path}" is not volatile` (`:507`, `:520`). This plugin's
  `Config` has **no** volatile field, so every settings write against
  `llm-aliyun` is refused before it reaches storage. This is the single blocking
  defect.
- **Values are references.** `.volatile()` "preserves a field's schema type and
  metadata while parsing its value into a stable reference read with `.get()`"
  (`schemastery/README.md:393`); `Schema.resolve` wraps the field value in
  `createVolatile` (`schemastery/src/index.ts:521-530`). The settings service
  unwraps them with `plainConfig` (`dsh-settings/lib/index.js:97-102`).
- **Writes persist into the profile's Cordis patch** (`dsh-settings/README.md:37`),
  so a GUI edit is durable and shows up in `cordis.patch.yml`.
- **A plugin that ships its own page says so.**
  `dsh-settings/README.md:39`: "A plugin that ships its own page registers
  `configure({ auto: false }, ctx.fiber)` as an effect inside an optional
  `ctx.inject(['settings'], …)` child from `apply`".

The canonical implementation is `@deepseek-ai/dsh-llm-pi-ai`, which does exactly
this (`lib/index.js:2532-2535`):

```js
ctx.inject(["settings"], (child) => {
  child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
});
const settingsNs = ctx.fiber.entry?.options.id ?? NS;
```

declares its editable surface as one volatile node
(`Config = z.object({ providers: z.dict(profile).default({}).volatile() })`,
`:1051`), and reads it live (`config.providers.get()`, `:2548`).

**The consequence for this plugin is not just a decorator.** Today the config is
read once, at mount: `lib/adapter.js:60` says so outright — "the configuration
carries no volatile field, so a configuration change remounts the plugin and
rebuilds this". Marking fields volatile *stops* the remount, so the plugin must
become reactive on its own: a changed `baseURL` has to rebuild the adapter's
profile map (through `setCatalog`), and has to re-point discovery at the new
endpoint.

## Mechanism 2 — a client half, and how one ships

`@deepseek-ai/dsh-client-modules` turns a package's `dsh.client` declaration
into a browser bundle. From its README and `lib/index.js`:

- The declaration and its validation (`lib/index.js:63-73`): `platform`
  (string, must be `"web"`), `inject` (string[]), `external` (string[]),
  `immediately` (boolean).
- The scan requires both halves, or it throws:
  "declares dsh.client but exports no `./client` bundle" (`lib/index.js:719`).
- `lib/client.js` must exist as a built artifact before launch; "a missing bundle
  fails activation loudly with one build instruction" (`README.md:50`).
- Resolution of a `require(...)` inside a bundle checks the **frozen platform
  module table** (React, Cordis, static UI libraries) first, then memoized
  records, then boot-graph rows, then registered factories (`README.md:46`,
  `README.md:68`).
- `dsh.client.external` adds non-baseline requests and creates module-graph
  ordering edges; cycles and self-requests are rejected (`lib/index.js:415-429`).

**No bundler is required.** The official plugin-development skill ships a
four-file template whose client half is 22 lines of hand-written lazy CJS
(`skills/cordis-plugin-development/templates/decoration/client.js`):

```js
window.__ModuleLoader__.load({
  id: '@local/my-decoration',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    …
    return { inject: ['slots'], apply(ctx) { … } };
  },
});
```

with the manifest beside it (`templates/decoration/package.json`):

```json
"exports": { ".": "./index.js", "./client": "./client.js" },
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "immediately": true,
    "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
  }
}
```

A shipped client plugin confirms the same shape in production:
`dsh-client-ui-settings-models/package.json:28` declares
`dsh.client = { inject: [...], platform: "web" }` and exports `./client` →
`lib/client.js`.

### The client-side toolkit a card needs

Everything is reachable as a **cordis service**, which is the sanctioned
cross-plugin channel — `dsh-client-ui-settings/lib/client.js:1258` explains why:
"the client bundle purity gate forbids cross-plugin value imports and directs
cross-plugin collaboration through cordis services".

- `ctx.configForms` (`lib/client.js:1264-1349`):
  - `get(entryId)` → a `ConfigFormController` for that host namespace,
  - `whileServed(namespaces, register)` → keeps a registration alive only while
    the host serves any of those namespaces, so a deployment without this plugin
    shows no trace of the card.
- `ConfigFormController` (`:1086-1255`): `getSnapshot()` (with `value`, `base`,
  `user`, `revision`, `writable`, `status`), `subscribe()`, `set(field, value)`,
  `unset(field)`, `mutate(ops, expectedRevision)`.
- Credentials are a separate wire namespace, used by the Models page itself
  (`dsh-client-ui-settings-models/lib/client.js:2783-2796`):
  `ctx.remote.credentials.describe([ref])`, `.set(ref, value)`, `.unset(ref)`.
- Registration into a keyed slot needs `options.key`
  (`dsh-client-ui-slots/lib/index.js:175-177`), and a duplicate key for the same
  slot throws.

`dsh-client-ui-settings-agent-loop/lib/client.js` (175 lines) is the closest
structural precedent: a small out-of-repo-shaped client plugin that edits one
host namespace through `configForms`, with `inject: ["slots", "locale",
"configForms"]` and `ctx.configForms.whileServed([...], () => ctx.slots.inject(…))`.

## Mechanism 3 — the generic form the page never asks for

`dsh-settings` already projects every volatile `Config` into a generic form
descriptor (`describe()`, `lib/index.js:413-463`) and reports `autoGenerate`,
which `dsh-settings/README.md:39` says is "enabled by default, for clients that
build pages from the schema; **no shipped client does so yet**". The primitives
even ship the pieces — `SettingsFormModel`, `SettingsForm`,
`SettingsValueField`, `SettingsSecretField`, `settingsTextField`,
`settingsNumberField` (`dsh-client-ui-primitives/lib/index.js:6918-7143`).

So the Models page could render a generic editor for any volatile namespace
instead of the disabled hint. That is a small change **in the harness**, not in
this package. Note its limits for that purpose: `SettingsFormModel` writes
single-segment paths only — `plan()` builds `{ op: "set", path: [field] }`
(`:7319-7343`) — so a nested `models` array would need `scope.mutate()` directly
even there.

## Recommended path: ship a client card

Self-contained; no harness change; uses the seat the page declares for exactly
this. Three pieces of work.

### 1. Host half — make the config live

- Mark the editable surface volatile, one node per fixed path (nesting a volatile
  field inside another volatile field throws —
  `schemastery/src/index.ts:493`): `displayName`, `apiKeyEnv`, `baseURL`,
  `reasoning`, `headers`, the `models` array, and the `discovery` object.
- Read every field through a small helper so a plain value still works:
  `const live = (field) => (field && typeof field.get === "function" ? field.get() : field)`.
- Add the page policy:
  `ctx.inject(['settings'], (child) => child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)))`.
- Make the mount reactive, because volatile fields stop the remount that used to
  do this work: rebuild the adapter's profile map via `setCatalog` when
  `baseURL`/`displayName`/`headers`/`apiKeyEnv`/`models` change, and re-point
  discovery when `baseURL` or the `discovery` object changes. The
  `settings/document-updated` event is the natural trigger — the settings
  service emits it with `(ns, revision)` (`dsh-settings/lib/index.js:435,461`)
  and the Models page already subscribes to it over the wire.
- Keep `models` and `discovery` validated as they are; `scripts/validate.mjs`
  and the existing tests cover the defaults and should be extended to the
  volatile surface.

### 2. Client half — `lib/client.js`

Hand-written lazy factory, `require('react')`, `React.createElement` (no JSX, no
bundler), registering one keyed card:

```js
ctx.slots.inject("settings.models.provider-card", () => ctx.slots.register({
  name: "settings.models.provider-card",
  key: "llm-aliyun",                    // = the host settings namespace
  inject: () => card.inject(),
}, AliyunCard))
```

guarded by `ctx.configForms.whileServed(["llm-aliyun"], …)` so nothing appears
unless the host serves the namespace, and wrapped in `ctx.effect`. The card
renders endpoint (`baseURL`), a write-only API-key field
(`ctx.remote.credentials.set(ref, value)`, reference read from the profile's
`apiKeyEnv` with the page's `<ROUTE>_API_KEY` derivation as the fallback), and
the model overrides, staged locally and committed with
`scope.mutate([...], revision)`. Visible text goes through `ctx.locale`; styling
uses `--dsw-alias-*` tokens and the card's own CSS.

Per the skill's UI rules (`references/practices.md:35`), the card must **not**
`require('@deepseek-ai/dsh-client-ui-primitives')`: "write your own controls and
match the host instead … copy markup, CSS, and behavior from the primitive into
the plugin", keeping only `--dsw-alias-*` token references. `dsh.client.inject`
entries are still allowed, since they only order activation.

A first version should keep the model overrides honest but small: a validated
JSON text area over the `models` array, saved as one `set` op, with a note that
an undisclosed id falls back to the `discovery.*` capacities. A row editor
matching the host's `ModelListEditor` is a follow-up.

### 3. Manifest

```json
"exports": { "./client": "./lib/client.js", … },
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "immediately": true,
    "inject": ["@deepseek-ai/dsh-client-ui-settings"]
  }
}
```

plus `lib/client.js` in `files`.

One wart to accept: expanding the row still renders the page's own
"advanced fields live in `cordis.patch.yml`" hint and disabled Apply, because
that branch is keyed on the namespace and cannot be suppressed from outside. The
card renders above it and is the working surface.

## Alternative: make the page generic instead

Have the Models page render a schema-driven editor (`autoGenerate` +
`SettingsFormModel`) for a provider row whose namespace it does not hand-write,
rather than the disabled hint. Then this plugin needs only volatile `Config`
fields and no client half at all — and every other provider plugin gets the same
for free. The cost is a change in the harness repository rather than in this
package, so it is worth raising upstream; it does not unblock this plugin by
itself.

## Open questions

- **Reactivity trigger.** Whether to react on `settings/document-updated` or on
  the cordis `internal/config` hook (`dsh-llm-pi-ai/lib/index.js:2556` uses the
  latter for validation). To be settled against a live edit.
- **Card placement on a first-run posture.** `needsSetup(row, anyUsable)` renders
  a *setup card* instead of a row when no provider is reachable and this
  credential is unconfigured (`lib/client.js:2135`). The slot is rendered there
  too, so the card must read sensibly in that posture.
- **Whether the Plugins page already offers a document-open affordance.**
  `dsh-api-settings-controller` exposes `settings.openSettingsDocument()`
  (`README.md:32`), which opens the profile patch in the native editor. Whether
  any visible button calls it was not checked.
