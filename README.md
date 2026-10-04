# @doitian/dsh-provider-aliyun

Aliyun **DashScope (Bailian)** as a model provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The plugin registers one provider route, `aliyun`, and **owns it outright** — endpoint, credential reference, protocol, and the Qwen model catalog. The catalog is a file in this package, so the model list moves forward with `pnpm update` and never has to be written into a profile.

```yaml
provider: aliyun
model: qwen3.8-max
```

## Why a plugin and not a config snippet

An OpenAI-compatible provider *can* be added to DSH with configuration alone — declare a route under `llm-pi-ai`'s `providers` and hand-write its model list. That works, and then the model list lives in your profile forever: every new Qwen release is a hand edit, and a profile patch replaces an entry's whole `config`, so nothing can merge models into it later.

This package takes the other route. It registers its own route on the LLM seam and ships the catalog as data:

| | Config-only route | This plugin |
|---|---|---|
| Where the model list lives | your `cordis.patch.yml` | `lib/catalog.js` in this package |
| Adding a new Qwen model | edit your profile | `pnpm update` |
| Can a profile patch shadow it | — | no |
| Your profile config | the whole provider block | nothing |

The trade-off is honest: the plugin depends on an internal shape of the adapter it reuses (see [How it works](#how-it-works)), which a config-only route does not.

## Requirements

- DeepSeek Harness `0.2.0-rc.2` with the `@deepseek-ai/dsh-base` bundle, which mounts the LLM seam this plugin registers on.
- An Aliyun DashScope / Bailian API key.
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

**Settings → Models → Aliyun DashScope** → paste the key into the **API key** field. It is written write-only to `$DSH_HOME/.credentials.yaml` under `ALIYUN_API_KEY`, and never read back.

Or export `ALIYUN_API_KEY` in the environment that launches DSH. Until the key resolves, selecting an Aliyun model fails immediately with `MISSING_CREDENTIAL`, before any network I/O.

### Endpoints

| Region | Endpoint |
|---|---|
| Mainland China (default) | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| International | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |

Set it in the Models page, or by adding `baseURL` to this entry's `config`:

```yaml
- id: llm-aliyun
  name: '@doitian/dsh-provider-aliyun'
  config:
    baseURL: https://dashscope-intl.aliyuncs.com/compatible-mode/v1
```

## Models

`lib/catalog.js` is the catalog. It ships six Qwen models:

`qwen3.8-max`, `qwen3.8-flash`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`, `qwen3.6-flash`

Capacities and thinking levels mirror the facts Aliyun publishes for its Qwen lineup. A catalog entry states only what is true of the *model* — id, display name, context window, output cap, accepted modalities, and thinking levels. The route, endpoint, protocol, and compatibility switches are filled in from configuration by `lib/models.js`, so updating the catalog never means touching pi-ai plumbing.

**Verify capacities against your endpoint when you upgrade.** A wrong `contextWindow` is the failure that hurts, because the harness trusts it when it decides to compact history.

### Updating the catalog

Edit `lib/catalog.js` and publish. Consumers get the new list with `pnpm update`.

### Overriding models for one profile

`models` is a normal configuration field whose default is the shipped catalog, so a profile can replace it without forking:

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
```

The Models page edits the same field, showing the shipped catalog as inherited rows until the first edit materializes an override.

### Thinking

Aliyun turns thinking on with a boolean `enable_thinking` rather than a reasoning-effort field, which is what `compat.thinkingFormat: 'qwen'` sends, and `supportsReasoningEffort: false` keeps an effort value off the wire where this endpoint would refuse it. The selected level still drives the boolean, so `off` genuinely turns thinking off.

`thinkingLevelMap` on each catalog entry declares which levels a model offers and the wire spelling of each. A level left out is not offered; `off` is offered unless it is named in the map.

## Uninstall

Remove it from `dsh.profile.bundles` (or delete the row on the Plugins page), then:

```bash
dsh plugin --profile <name> remove @doitian/dsh-provider-aliyun
```

The credential in `$DSH_HOME/.credentials.yaml` is left untouched. Deleting the route on the Models page removes it only when its reference is exactly the page-derived `ALIYUN_API_KEY`; a custom reference is retained deliberately, because the page cannot prove it owns it.

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

On mount, `lib/index.js` registers two things on the LLM seam: the `aliyun` route with an adapter, and a configurable-provider directory entry — the latter is what gives the route a row, and an API-key field, on the Models page.

The adapter is `PiAiAdapter`, exported by `@deepseek-ai/dsh-llm-pi-ai`. It owns the hard part — harness history into pi-ai context, pi-ai events into harness stream chunks, image budgets, replay metadata, idle watchdogs — and reusing it is what keeps this package a catalog plus a few dozen lines instead of a second adapter implementation.

**The one thing to know if you maintain this.** `PiAiAdapter` is driven by a route's *resolved profile*, a shape its package does not export as a type; `lib/adapter.js` reproduces it and documents every field it must carry. Model metadata is not read from that profile — it comes from the pi-ai model descriptors built out of the catalog, which is why the catalog can live here at all. A DSH upgrade that starts reading a new profile field breaks this plugin. `test/adapter.test.mjs` drives the real published adapter against the factory, so that break shows up as a failing test rather than as a broken route in someone's profile.

The engine is pinned to the harness's own pi-ai: the dependency is `^0.87.1`, which resolves to exactly the `0.87.1` the harness installs, so both share one copy.

## Development

```bash
npm install
npm run validate   # manifest, patch wiring, catalog integrity
npm test           # drives the real PiAiAdapter against the catalog
```

`scripts/validate.mjs` catches what would otherwise fail silently: a tarball that drops the patch, a patch that names the wrong package, a duplicate model id, a non-integer capacity, a level map pi-ai would read as offering nothing.

`npm test` needs the peer packages installed — that is the point, since it exercises the real adapter rather than a stub. A live request is out of scope: that needs a real key and endpoint.

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

`--environment` is deliberately omitted, matching the publish job, which declares no `environment:`.

If the registry reports the package as missing, a trusted publisher cannot be attached to a name that does not exist yet: publish `0.1.0` once by hand, then run the command above and let the workflow own every release after that.

Then release:

```bash
npm version patch
git push --follow-tags
gh release create v0.1.1 --generate-notes
```

The publish job requires the release tag to match `package.json` (`v0.1.1` ↔ `0.1.1`) and re-runs validation and tests before uploading.

Two things that will bite when editing the workflow:

- **`pnpm publish` does not work here.** It performs no OIDC exchange. Use `npm publish`.
- **Pushing `.github/workflows/` needs the `workflow` token scope.** An OAuth token without it is rejected for workflow files even though it can push everything else; add the scope with `gh auth refresh -h github.com -s workflow`, or use an SSH remote, which is not scope-limited.

## License

MIT
