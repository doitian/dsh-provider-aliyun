# @doitian/dsh-provider-aliyun

Aliyun **DashScope (Bailian)** as a model provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The plugin registers one provider route, `aliyun`, and **owns it outright** — endpoint, credential reference, protocol, and the model catalog. The catalog is *live*: the route asks the configured endpoint which models it serves (`GET {baseURL}/models`), so a model Aliyun publishes tomorrow is selectable without a package release. A shipped fallback list covers the time before the first listing arrives, and supplies the capacities a listing does not disclose.

```yaml
provider: aliyun
model: qwen3.8-max
```

## Why a plugin and not a config snippet

An OpenAI-compatible provider *can* be added to DSH with configuration alone — declare a route under `llm-pi-ai`'s `providers` and hand-write its model list. That works, and then the model list lives in your profile forever: every new Qwen release is a hand edit, and a profile patch replaces an entry's whole `config`, so nothing can merge models into it later.

This package takes the other route. It registers its own route on the LLM seam and ships the catalog as data:

| | Config-only route | This plugin |
|---|---|---|
| Where the model list comes from | your `cordis.patch.yml` | the endpoint, re-read as it ages |
| Adding a model Aliyun starts serving | edit your profile | nothing — the next listing already has it |
| Capacities for a model nobody listed | you write them | shipped for the fallback ids, conservative defaults otherwise |
| Can a profile patch shadow it | — | no |
| Your profile config | the whole provider block | nothing, or just a `baseURL` |

The trade-off is honest: the plugin depends on internal shapes of the adapter and the discovery contract it uses (see [How it works](#how-it-works)), which a config-only route does not.

## Requirements

- DeepSeek Harness `0.2.0-rc.2` with the `@deepseek-ai/dsh-base` bundle, which mounts the LLM seam this plugin registers on.
- An Aliyun DashScope / Bailian API key.
- **An endpoint that answers `GET {baseURL}/models`.** The workspace hosts and the public compatible-mode endpoints do; a deployment that does not still works — the route just advertises the fallback catalog, and you can hand-list models with `models` in configuration instead.
- **No `aliyun` route configured through `llm-pi-ai`.** Two adapters cannot declare the same route: mounting this plugin while a profile still configures one fails with `configurable provider "aliyun" is already declared`. Remove that block from your profile patch first — that is the whole point of the plugin.

## Install

**Desktop app.** Sidebar **Plugins** → install `@doitian/dsh-provider-aliyun`. A newly installed bundle is enabled by default.

**Any other profile.** `dsh plugin` forwards its arguments to pnpm in the profile directory:

```bash
dsh plugin --profile <name> add @doitian/dsh-provider-aliyun
```

Then make sure the bundle is *selected* — a raw `add` installs the dependency but does not add it to `dsh.profile.bundles` in the profile's `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@doitian/dsh-provider-aliyun"]
    }
  }
}
```

> The `dsh plugin` CLI refuses the `desktop` profile (`profile "desktop" is managed exclusively by the Electron application`); use the Plugins page there.

## Configure the API key

Nothing is needed to make the route exist, and no key is stored in this package or in any profile patch. The route resolves a credential reference per request:

```
apiKeyEnv: ALIYUN_API_KEY   # the default
```

Store it under `refs:` in `$DSH_HOME/.credentials.yaml`:

```yaml
refs:
  ALIYUN_API_KEY: sk-…
```

The store watches that file and reloads it on change, so a key added while DSH is running takes effect on the next request — and on the next model listing, which is what turns the fallback catalog into the endpoint's own. Or export `ALIYUN_API_KEY` in the environment that launches DSH; that layer wins over the file and is reported read-only. Until the key resolves, selecting an Aliyun model fails immediately with `MISSING_CREDENTIAL`, before any network I/O.

> **A profile is not needed for this.** The Models page card below writes the key, the endpoint, and the model overrides, and an environment variable still wins over both.

### Endpoints

| Region | Endpoint |
|---|---|
| Mainland China, public (default) | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| International | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| Bailian *workspace* | `https://llm-<workspace-id>.<region>.maas.aliyuncs.com/compatible-mode/v1` |

A workspace endpoint is the per-workspace host the console hands out; keys are often issued against one, and the workspace id is yours, so it can only come from configuration:

```yaml
- id: llm-aliyun
  name: '@doitian/dsh-provider-aliyun'
  config:
    baseURL: https://llm-<workspace-id>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
```

Keep the endpoint and the key from the same product: a workspace key is not interchangeable with the public compatible-mode endpoints, and a *Token Plan* key belongs to `token-plan.<region>.maas.aliyuncs.com` instead.

## The Models page

**Settings → Models** shows the `aliyun` row with a card under it that edits three things: the **endpoint**, the **API key**, and the **model overrides**. Saving writes the first and third into the profile's `cordis.patch.yml` through the settings service and the key into the credential store under whatever reference the profile names — so the page and a hand-written patch are the same configuration, and whichever one you use, the other one keeps working.

Nothing needs a restart. The route's configuration is `.volatile()`, which is what makes it writable from a page at all, and the plugin re-reads it rather than being remounted: a new endpoint is what the next listing reads, and a new display name replaces the row in place.

| Field | What it writes | Notes |
|---|---|---|
| Endpoint | `baseURL` | Clearing it unsets the override, so the shipped default returns. |
| API key | the credential reference, no config field | Write-only: the page never reads a stored key back, only whether one is configured. The reference comes from `apiKeyEnv`, defaulting to `ALIYUN_API_KEY`. |
| Model overrides | `models` | The pin list as JSON. **Reset to the shipped catalog** unsets the override. |

Two things the card deliberately does not edit, because a provider-scoped control cannot decide them well: `discovery` (the membership filter and its pacing) and `headers`. Both stay in `cordis.patch.yml`. Reasoning effort is absent for the same reason the harness's own editor omits it — it is a per-*model* capability, so the picker offers each model its own levels.

> **Why a card and not just a schema.** The Models page renders a per-provider editor only for the `llm-deepseek` and `llm-pi-ai` namespaces — a hardcoded pair, with every other namespace getting a hint and a disabled Apply. What the page does offer a plugin from outside the harness is a keyed extension slot, `settings.models.provider-card`, so this package ships a browser half that registers one card against its own row. See [docs/models-page-settings.md](docs/models-page-settings.md) for the full picture, including the schema-driven editor it *could* use if the page ever grew one.

## Models

The route advertises what the endpoint serves. On mount — and again whenever a listing goes stale or a credential is stored — the plugin calls `GET {baseURL}/models` and adopts the ids it finds, in the endpoint's own order. Within what the filter admits, membership follows that listing, removals included: a model Aliyun retires stops being selectable without a package release, and one it starts serving appears the same way.

Three things a listing does not do, and what happens instead:

| | Behaviour |
|---|---|
| Capacities | A listing discloses ids, not context windows. An id the fallback catalog names keeps its written facts; every other id gets the conservative defaults (`discovery.contextWindow`, `discovery.maxTokens`, `discovery.input`), because the harness trusts `contextWindow` when it compacts history and a generic number beats an invented precise one. |
| Failure | A failed read changes nothing: the last good listing stays in effect, and before the first one the fallback catalog does. A listing that names nothing counts as a failure — `{"data":[]}` says nothing about what an endpoint serves. |
| Latency | Only a model-list read waits for the endpoint, and only for `discovery.waitMs`. Every other read merely schedules a refresh, so a picker opened during a slow fetch shows what is already known. |

The shipped fallback list is three models: `qwen3.8-max`, `deepseek-v4.1-flash`, `glm-5.3`. It is *also* the metadata table, which is the whole trick — anything worth naming here gets your numbers.

**A listing is a catalogue, not a chat menu.** A workspace endpoint answers with everything the account can reach — on the workspace this plugin was developed against, 262 entries covering speech synthesis, speech recognition, image generation, embeddings, rerankers, realtime duplex models, and every legacy generation back to `qwen-7b-chat`. The listing discloses `id`, `object`, `created`, and `owned_by`, so *what an id is* cannot be read from the listing at all. Two things decide it instead, and the default uses both: name patterns from configuration, and the shipped metadata snapshot, which states outright whether a model reads and answers text. On that endpoint the three modes come out as:

| `discovery.filter` | Advertised | What admits an id |
|---|---|---|
| `chat` (default) | 79 of 262 | the include patterns, or the snapshot knowing it as a chat model |
| `patterns` | 44 of 262 | the include patterns alone — the tight picker |
| `all` | 175 of 262 | everything the listing names, minus `exclude` |

### Model facts

The listing carries no capacities, and the harness trusts `contextWindow` when it decides to compact history, so facts come from `lib/metadata.json`: a generated snapshot of [models.dev](https://models.dev)'s `alibaba-cn` and `alibaba` providers, committed here so nothing at run time depends on a third party. It covers 98 models with real context windows, output caps, accepted modalities, and whether a model can think — `qwen3.8-max` at 1M/131072, `qwen3-vl-plus` at 262144/32768 with image input, `kimi-k3`, `glm-5.3`, and so on.

```bash
npm run generate:metadata   # refresh lib/metadata.json from models.dev
```

Precedence is fixed, most authoritative first: an entry in `models` is used exactly as written, then the snapshot, then the conservative defaults below. Membership stays the endpoint's business — the snapshot only admits a model the endpoint actually listed, and a model newer than the snapshot is still advertised when a pattern matches it, just with default numbers. Regenerating is a normal code change: `npm test` fails if the snapshot and the shipped catalog disagree about a model they both name.

**Verify capacities against your endpoint when you upgrade.** A wrong `contextWindow` is the failure that hurts.

### Discovery configuration

```yaml
- id: llm-aliyun
  name: '@doitian/dsh-provider-aliyun'
  config:
    discovery:
      enabled: true          # false pins the route to `models`
      filter: chat           # chat | patterns | all, as the table above
      include:               # chat families to keep, as case-insensitive regular expressions
        - '^qwen3\.8-(max|flash|omni-flash)$'
      exclude:               # dropped in every mode, even when a pattern matched
        - '-realtime$'
      ttlMs: 600000          # how long a listing stays fresh; 0 asks on every read
      waitMs: 2000           # longest a model list waits for a cold listing
      timeoutMs: 15000       # idle bound on one listing request
      contextWindow: 131072  # capacity for an id neither `models` nor the snapshot names
      maxTokens: 32768
      input: [text]
```

Two rules keep the filter from hiding something you asked for. An id named in `models` is advertised whatever the patterns and the snapshot say — naming a model is a stronger statement than either — and a pattern that does not compile is ignored with a warning instead of failing the mount. `include` and `exclude` replace the shipped defaults, so copy the ones you want to keep from `lib/catalog.js`. `exclude` is also the way to trim what the snapshot admits, e.g. `- '^siliconflow/'` to drop one vendor's aliases of models that are already listed canonically.

Note what a discovered model gets for modalities: whatever the snapshot publishes, and `discovery.input` for everything else. A model neither source knows is advertised text-only, because neither a listing nor a guess says it accepts images; naming it in `models` settles the question.

After a failed attempt the endpoint is left alone for a minute, so an unreachable host cannot make every read slow; storing or rotating the key retries immediately.

### Pinning the catalog

`models` decides the fallback membership *and* the metadata, and a profile can replace it without forking:

```yaml
- id: llm-aliyun
  name: '@doitian/dsh-provider-aliyun'
  config:
    models:
      - id: qwen3.8-max
        name: Qwen3.8 Max
        contextWindow: 1000000
        maxTokens: 131072
        input: [text, image]
        reasoning: true
        thinkingLevelMap: { low: low, medium: medium, high: high }
        compat: { supportsReasoningEffort: true }
```

With `discovery.enabled: false` this list is the entire route.

### Thinking

Aliyun turns thinking on with a boolean `enable_thinking`, which is what `compat.thinkingFormat: 'qwen'` sends, and a model that takes one accepts a `reasoning_effort` beside it. The route default is `supportsReasoningEffort: false`, because discovery advertises whatever a workspace lists and this endpoint answers an effort it does not recognize with a 400 — so by default the selected level drives the boolean, and `off` genuinely turns thinking off.

`thinkingLevelMap` on each catalog entry declares which levels a model offers and the wire spelling of each. A base level (`off` through `high`) is offered unless it is mapped to `null`; `xhigh` and `max` are offered only when named. `null` is therefore how a model refuses a level — and for a base level it is the *only* way, since leaving one out still offers it.

`compat` on an entry overrides the route's switches for that model alone. The three shipped entries use it, because their endpoint behaviour has been checked rather than assumed: `supportsReasoningEffort: true` puts the level on the wire, and each map states the vocabulary that endpoint validates. Qwen3.8 Max and DeepSeek V4.1 Flash take every level through `max` (DeepSeek also takes `ultra`, for which pi-ai has no level name), while GLM-5.3 takes only `low`/`high`/`max` and refuses even `enable_thinking: false` — so its other levels are mapped to `null` instead of being left in a selector that would 400.

A discovered model the fallback does not name keeps the route switches and the conservative level set (`low`/`medium`/`high`), and one with no facts at all is declared non-reasoning: a level map is a claim about a model, and claiming thinking it may not have would offer levels the endpoint can refuse. Name the model in `models` to give it levels.

## Uninstall

Remove it from `dsh.profile.bundles` (or delete the row on the Plugins page), then:

```bash
dsh plugin --profile <name> remove @doitian/dsh-provider-aliyun
```

The credential in `$DSH_HOME/.credentials.yaml` is left untouched.

## How it works

`package.json` declares a bundle patch:

```json
{ "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

and the patch inserts this package's own plugin entry:

```yaml
- insert:
    - id: llm-aliyun
      name: '@doitian/dsh-provider-aliyun'
```

On mount, `lib/index.js` registers three things on the LLM seam: the `aliyun` route with an adapter, a configurable-provider directory entry — that is the row on the Models page — and a model-discovery offer for the entry's settings namespace, so a configuration surface can interrogate this route's endpoint with a draft credential. The same manifest also declares a browser half, which is what puts the card on that row:

```json
{ "dsh": { "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-settings"] } } }
```

`lib/client.js` is that half. It is **not built**: it is hand-written in the browser's own module-loader format, taking React from the frozen platform module table and importing nothing else, because a harness client package changes shape without notice and a component that throws blanks its own slot entry. Its two collaborators are cordis services rather than modules — `ctx.configForms` for the revision-fenced settings write, `ctx.remote.credentials` for the key — which is the channel DSH directs cross-plugin collaboration through. `scripts/validate.mjs` loads the bundle in a stub module system and asserts what it registered, since a wrong module id has no host-side symptom at all.

**Why the fields are volatile, and what that costs.** The settings service refuses a write to a field that is not `.volatile()`, so the mark is the price of a page field; in exchange the value becomes a reference read with `.get()` instead of a value resolved once at mount. That inverts the old contract — *"the configuration carries no volatile field, so a configuration change remounts the plugin"* — so the plugin now re-derives what the configuration owns: the adapter reads its route facts on every rebuild (`lib/adapter.js`), and `sync()` in `lib/index.js` rebuilds the discovery client when the endpoint moves and re-announces the catalog when the pin list or the filter does. It runs from every read as well as from `settings/document-updated`, and compares first, so the second call is free.

The adapter is `PiAiAdapter`, exported by `@deepseek-ai/dsh-llm-pi-ai`. It owns the hard part — harness history into pi-ai context, pi-ai events into harness stream chunks, image budgets, replay metadata, idle watchdogs — and reusing it is what keeps this package a catalog plus a few dozen lines instead of a second adapter implementation.

**How the advertised catalog moves.** `lib/discovery.js` reads the endpoint's listing and holds one `ids` array; `lib/models.js` merges it with the fallback entries; `lib/adapter.js` swaps the profile *map* the adapter memoizes its snapshot by identity. An operation already in flight keeps the snapshot it started with, and the next read sees the new catalog — which is also why a refresh never interrupts a stream. The harness's session catalog calls `listModels()` per provider on every read, so the picker shows whatever the route advertises at that moment. Only `listModels` waits for a cold listing, and that wait lives in a two-line subclass rather than a reimplementation of the adapter.

**The one thing to know if you maintain this.** `PiAiAdapter` is driven by a route's *resolved profile*, a shape its package does not export as a type; `lib/adapter.js` reproduces it and documents every field it must carry. Model metadata is not read from that profile — it comes from the pi-ai model descriptors built out of the catalog, which is why the catalog can live here at all. A DSH upgrade that starts reading a new profile field breaks this plugin. `test/adapter.test.mjs` drives the real published adapter against the factory, so that break shows up as a failing test rather than as a broken route in someone's profile. The discovery contract is a second such seam: `LlmModelDiscoveryRequest`, `registerModelDiscovery`, and the `attributionHeaders()` requirement on every provider HTTP request.

A third seam is entirely on the client: `lib/client.js` reaches the page through the keyed `settings.models.provider-card` slot and the `configForms` service, neither of which this package owns. Two signs that one moved: the card is absent with `slot entry crashed in 'settings.models.provider-card'` in the browser console, or `ctx.configForms.get()` returns a scope whose writes the host refuses. `test/client.test.mjs` drives the bundle through a stub module system and asserts the registration, the controls, and the two-write save, which is as far as a check can go without a page.

The engine is pinned to the harness's own pi-ai: the dependency is `^0.87.1`, which resolves to exactly the `0.87.1` the harness installs, so both share one copy.

## Development

```bash
npm install
npm run validate   # manifest, patch wiring, fallback catalog, discovery defaults, browser half
npm test           # drives the real PiAiAdapter, the mount, the merge, the listing state machine, and the card
```

`scripts/validate.mjs` catches what would otherwise fail silently: a tarball that drops the patch, a patch that names the wrong package, a duplicate model id, a non-integer capacity, a level map pi-ai would read as offering nothing, a discovery default that would produce a model the adapter cannot dispatch — and, for the browser half, a bundle that registers nothing, registers under the wrong module id, exports no `apply`, or requires a harness client package instead of taking only React from the module table. That last one has no host-side symptom at all: the plugin mounts, the row appears, and the card is simply blank.

`npm test` needs the peer packages installed — that is the point, since it exercises the real adapter rather than a stub. A live request is out of scope: that needs a real key and endpoint. Discovery is tested with an injected `fetch`, so what is covered is every decision *around* the request — the shapes it reads, what a failure leaves in place, and how long a read may wait. `lib/client.js` is tested by loading it the way the page does and driving the card with a stub `React.createElement`, so its validation, its save order, and what a refused write leaves behind are all covered without a browser.

> Under a DSH file sandbox, `npm test` fails with `spawn EPERM`: Node's test runner starts one child process per file, and the sandbox blocks the pipes. Run `node --test --test-isolation=none` to execute the same suite in one process.

### Testing a build against the desktop app

Point the desktop profile at this checkout once, as a `link:` dependency:

```bash
pnpm --dir ~/.dsh/profiles/desktop add "link:C:/Users/me/codebase/dsh-provider-aliyun"
npm run probe   # what the picker will show, read from the live endpoint
```

Then **restart DSH** after a change: plugin modules are loaded once at startup, and the loader does not watch them.

`link:` is what makes that loop work, and it is what `@doitian/dsh-music` in the same profile already uses: the entry in the profile's `node_modules` becomes a symbolic link to the worktree, so what the app reads next is the worktree itself. A `file:` dependency is the opposite — a copy — and it goes stale on exactly the edits this loop is made of: an atomic editor save, or a `git checkout`, *replaces* a file rather than overwriting it, and the copy keeps the previous bytes. A plain `install`, `--force` or `update` will not re-link it ("Already up to date", even when the directory is deleted).

The trade is that pnpm does not install a linked package's dependencies: they resolve out of this checkout's own `node_modules` instead of the profile's, which is why the pi-ai range here is pinned to the copy the harness uses. Two things to expect while testing this way. The Plugins page may rewrite the dependency to a registry range — that is a normal package install, and re-adding the `link:` spec puts it back. And a *published* release is the durable alternative: the app then installs it like any other plugin, and nothing local is involved.

## Publishing

Publishing uses **npm trusted publishing** (OIDC) from `.github/workflows/publish.yml`. There is no npm token anywhere: no `NODE_AUTH_TOKEN`, no `NPM_TOKEN`, no secret. The workflow declares `id-token: write` and runs `npm publish`, which exchanges that OIDC identity for a short-lived publish token.

One-time setup, as the package owner. npm 11.6 or later creates the publisher from the CLI — the same operation as the website form, without the form:

```bash
npm login   # as doitian

npm trust github @doitian/dsh-provider-aliyun \
  --file publish.yml \
  --repo doitian/dsh-provider-aliyun \
  --allow-publish
```

`--allow-publish` is required: it grants the `CREATE_PACKAGE` permission, and the command refuses without it or `--allow-stage-publish`. It infers `owner/repo` from `package.json` when `--repo` is omitted, warns when the two disagree, requires 2FA, and prompts for an OTP. Add `--dry-run` first to see exactly what it would create without committing it.

**A bypass-2FA token cannot do this step.** npm is retiring tokens that bypass 2FA, and the
restriction is asymmetric: such a token still *publishes*, but the registry refuses it for
publisher management with

```
Granular access tokens that bypass two-factor authentication may not perform this action.
```

So the bootstrap publish can come from a bypass token, while attaching the publisher needs an
interactive `npm login` session or the website form. Reading the config back is refused for
the same reason, so the release itself is the practical check.

**Account two-factor authentication does not reach the workflow.** The publish job authenticates
with an OIDC token, so no one-time password is involved and enabling 2FA on the npm account
cannot break a release — v0.1.1 was published exactly this way. What 2FA does gate is the
one-time publisher setup above: an account with 2FA can run `npm trust`, which is the step a
2FA-bypassing token is refused. Publishing by hand from a terminal is the only flow that now
asks for an OTP.

`--environment` is deliberately omitted, matching the publish job, which declares no `environment:`.

If the registry reports the package as missing, a trusted publisher cannot be attached to a name that does not exist yet: publish `0.1.0` once by hand, then run the command above and let the workflow own every release after that.

Then release:

```bash
npm version patch          # or skip it when the version is already committed in package.json
git push --follow-tags
gh release create v0.1.1 --generate-notes
```

`npm version` writes the version, commits it, and tags it in one step. When the version you mean
to release is already committed by hand — a feature release that bumped `minor` itself — tag that
commit instead: `git tag v0.2.0 && git push --follow-tags`, then create the release for it.

The publish job requires the release tag to match `package.json` (`v0.1.1` ↔ `0.1.1`) and re-runs validation and tests before uploading.

Two things that will bite when editing the workflow:

- **`pnpm publish` does not work here.** It performs no OIDC exchange. Use `npm publish`.
- **Pushing `.github/workflows/` needs the `workflow` token scope.** An OAuth token without it is rejected for workflow files even though it can push everything else; add the scope with `gh auth refresh -h github.com -s workflow`, or use an SSH remote, which is not scope-limited.

## License

MIT
