# @doitian/dsh-provider-aliyun

An **Aliyun DashScope (Bailian) provider preset** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Installing this bundle registers one extra model provider route named `aliyun` on the
`llm-pi-ai` adapter: Aliyun's OpenAI-compatible DashScope endpoint, carrying a starter
Qwen model catalog. After installing, pick an Aliyun model in the composer like any
other provider.

```yaml
provider: aliyun
model: qwen3.8-max
baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
```

## What this is, and what it is not

It is **configuration only** — one patch layer, no runtime code. That is not a
limitation of this package; it is how an OpenAI-compatible provider is added to DSH.
`@deepseek-ai/dsh-llm-pi-ai` is the adapter, pi-ai supplies the wire protocol, and the
`providers` dictionary is the entire extension surface. This bundle exists so that
adding Aliyun is one install instead of a hand-written profile patch.

It is **not** a new adapter. If you need a protocol pi-ai cannot speak, or a credential
flow a key plus an endpoint cannot describe, this preset is the wrong tool — no config-only
bundle can reach that.

## Requirements

- DeepSeek Harness with the `@deepseek-ai/dsh-base` bundle (every standard profile), so that
  `llm-pi-ai` is mounted. It is mounted dormant with zero routes until a profile supplies
  providers, which is exactly what this bundle does.
- An Aliyun DashScope / Bailian API key.
- No new dependency on pi-ai: DashScope is OpenAI-compatible.

## Install

**Desktop app.** Sidebar **Plugins** → install `@doitian/dsh-provider-aliyun`. The page
enables a newly installed bundle by default.

**Any other profile.** The `plugin` subcommand forwards its arguments to pnpm in the profile
directory:

```bash
dsh plugin --profile <name> add @doitian/dsh-provider-aliyun
```

Then make sure the bundle is *selected* — a raw `add` installs the dependency but does not
add it to `dsh.profile.bundles` in the profile's `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@doitian/dsh-provider-aliyun"]
    }
  }
}
```

> The `dsh plugin` CLI refuses the `desktop` profile (`profile "desktop" is managed
> exclusively by the Electron application`); use the Plugins page there.

## Configure the API key

The key is never stored in this package or in any profile patch. The preset points at a
credential reference, and the harness resolves it per request:

```
apiKeyEnv: ALIYUN_API_KEY
```

**Settings → Models → Aliyun DashScope** → paste the key into the **API key** field. The page
writes it write-only to `$DSH_HOME/.credentials.yaml` under `ALIYUN_API_KEY`. Nothing secret
enters a config file, and the field is not read back.

Alternatively, export `ALIYUN_API_KEY` in the environment that launches DSH. The credential
seam is consulted before the process environment. Until the key resolves, selecting an Aliyun
model fails immediately with `MISSING_CREDENTIAL` — no network request is attempted.

### Change the endpoint

The same card's **Customized settings** fold has a **base URL** field, so the endpoint is
editable without touching YAML:

| Region | Endpoint |
|---|---|
| Mainland China (default) | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| International | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |

## Models

A route pi-ai does not ship must spell out its models, so this preset seeds six:

`qwen3.8-max`, `qwen3.8-flash`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus`, `qwen3.6-flash`

Capacities and thinking levels come from Aliyun's own published Qwen catalog. Treat the list
as a **starter**, not as authority: DashScope serves models it does not name here and retires
models it does name.

**Adopt the real list for your endpoint.** Open **Settings → Models → Aliyun DashScope** and
use model discovery, which issues `GET {baseURL}/models` with your stored key and offers the
result for adoption. Discovery never writes configuration on its own — you adopt the entries
you want. You can also add, edit and remove model rows by hand, including context window,
max output tokens, and text/image input types.

### Thinking

`compat.thinkingFormat: qwen` is what makes the levels work: Aliyun turns thinking on with
`enable_thinking` rather than a reasoning-effort field, so `supportsReasoningEffort: false`
keeps an effort value off the wire while the selected level still drives the switch.
`reasoningEfforts` on each model declares which levels the selector offers. Models you add
yourself default to non-reasoning; declare `reasoningEfforts` to opt one in, or set `false`
to say so explicitly.

## If you already configure `llm-pi-ai`

**This is the one sharp edge, and it is worth reading.**

A patch layer replaces an entry's `config` as a single value, and layers are applied
bundles-first with your own `cordis.patch.yml` last. So if your profile already sets
`llm-pi-ai.config` — for example to register a second provider — then **your layer wins
wholesale and this bundle's `aliyun` route is never registered.** Not merged, not warned
about: simply replaced.

That is not specific to this package; the same is true of any bundle that targets an entry
you also configure. The fix is to merge the route into your own entry by hand:

```bash
# copy providers.aliyun from the installed cordis.patch.yml, or:
cat node_modules/@doitian/dsh-provider-aliyun/examples/merge-into-your-own-patch.yml
```

`examples/merge-into-your-own-patch.yml` is a ready-to-paste fragment that keeps your
existing routes alongside `aliyun`.

You can check what actually composed with:

```bash
dsh --profile <name> --dump-config
```

If `providers.aliyun` is absent from the `llm-pi-ai` entry there, your own layer replaced it.

## Uninstall

Remove it from `dsh.profile.bundles` (or delete the row on the Plugins page), then:

```bash
dsh plugin --profile <name> remove @doitian/dsh-provider-aliyun
```

Removing the bundle leaves the credential in `$DSH_HOME/.credentials.yaml` untouched.
Deleting the Aliyun route from the Models page removes the credential only when its reference
is exactly the page-derived `ALIYUN_API_KEY`; a custom reference is retained deliberately,
because the page cannot prove it owns it.

## How it works

`package.json` declares a DSH bundle patch:

```json
{ "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

and `cordis.patch.yml` overrides the `llm-pi-ai` entry mounted by `dsh-base`, asserting the
module name so the patch fails loudly if that entry ever stops being the adapter:

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      aliyun: { ... }
```

`lib/index.js` is `export {}` — the same shape as `dsh-base`. This bundle is a patch layer,
and nothing ever imports its module.

## Development

```bash
npm install
npm run validate
```

`scripts/validate.mjs` mirrors the constraints the harness itself enforces — the supported
protocol table, the `openai-completions` compat gate, modalities, thinking levels, and the
"a hand-declared route needs `api`, `baseURL` and a non-empty `models` list" rule — plus the
manifest-to-patch wiring and the tarball contents. It is a fast fail in CI, not a substitute
for the adapter's own validation, which still runs when your profile composes.

CI runs it on every push and pull request.

## Publishing

Publishing uses **npm trusted publishing** (OIDC) from `.github/workflows/publish.yml`. There
is no npm token anywhere: no `NODE_AUTH_TOKEN`, no `NPM_TOKEN`, no secret. The workflow
declares `id-token: write` and runs `npm publish`, which exchanges that OIDC identity for a
short-lived publish token.

One-time setup, in the package owner's npm account:

1. npmjs.com → the package → **Settings** → **Trusted Publisher** → **GitHub Actions**
   - Repository: `doitian/dsh-provider-aliyun`
   - Workflow filename: `publish.yml`
   - Environment: leave empty
2. If npm requires the package to already exist before a trusted publisher can be attached,
   publish `0.1.0` once by hand; the workflow owns every release after that.

Then release:

```bash
npm version patch          # or minor / major
git push --follow-tags
gh release create v0.1.1 --generate-notes
```

The publish job requires the release tag to match `package.json` (`v0.1.1` ↔ `0.1.1`) and
re-runs validation before uploading.

Two things that will bite when editing the workflow:

- **`pnpm publish` does not work here.** It performs no OIDC exchange. Use `npm publish`.
- **Pushing `.github/workflows/` needs the `workflow` token scope.** An OAuth token without
  it is rejected for workflow files even though it can push everything else; add the scope
  with `gh auth refresh -h github.com -s workflow`, or an SSH remote, which is not
  scope-limited.

## License

MIT
