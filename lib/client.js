/**
 * The Models-page card for this plugin: browser half.
 *
 * ## Why this file exists
 *
 * The Models page renders a per-provider editor only for the `llm-deepseek` and
 * `llm-pi-ai` settings namespaces; every other namespace gets a hint and a
 * disabled Apply. What that page *does* offer a plugin from outside the harness
 * is a keyed extension slot, `settings.models.provider-card`, dispatched with
 * `entryKey = settingsNs` — so this module registers one card against this
 * plugin's own entry id and renders inside its own row.
 *
 * ## What it is
 *
 * Not a bundle. A lazy CommonJS factory in the browser's own module-loader
 * format, written by hand: the platform module table already carries React, so
 * there is no JSX pass, no bundler, and no build step for this package. The
 * factory only registers a function — every side effect lives in `apply` and is
 * owned by the context there.
 *
 * Two deliberate dependencies, both *services* rather than module imports, which
 * is the channel DSH directs cross-plugin collaboration through:
 *
 * - `ctx.configForms` names this plugin's host entry and gives a form over the
 *   volatile `Config` fields, with revision-fenced writes.
 * - `ctx.remote.credentials` stores the API key. The key itself is write-only
 *   across that wire and never rides a response, so the card can only report
 *   whether one is configured.
 *
 * Everything else is local: the controls, their styles, and the store they read
 * through. A throwing component blanks its own slot entry, so the card is
 * written defensively and imports nothing that can change shape underneath it.
 *
 * @module @doitian/dsh-provider-aliyun/client
 */

window.__ModuleLoader__.load({
  id: '@doitian/dsh-provider-aliyun',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale dictionary this card owns. */
    const COPY_NS = 'settings.aliyun'
    /** The host plugin entry id, which is also its settings namespace. */
    const SETTINGS_NS = 'llm-aliyun'
    /** The route whose row this card renders. */
    const ROUTE = 'aliyun'
    /** Fields the card edits, in the order it renders them. */
    const FIELDS = ['baseURL', 'models']
    /** A key must be printable ASCII, which is what an HTTP header value carries. */
    const LEGAL_API_KEY = /^[\x21-\x7E]+$/
    /** A pasted `NAME=value` environment line, which is a mistake rather than a key. */
    const ENV_LINE = /^[A-Z][A-Z0-9_]*=[^=]/

    const en = {
      title: 'Aliyun DashScope connection',
      endpoint: 'Endpoint',
      endpointHint: 'OpenAI-compatible base URL. A Bailian workspace host works here; the model list is read from {endpoint}/models.',
      endpointPlaceholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'API key',
      apiKeyHint: 'Stored write-only as {ref}. Leave blank to keep the stored key.',
      apiKeyRefNote: 'The Models page never asks for the reference name; it comes from this plugin, which reads {ref}.',
      keyStored: 'Stored',
      keyMissing: 'Not set',
      models: 'Model overrides',
      modelsHint: 'The pin list as JSON. A model named here is always advertised and keeps the capacities written here; discovery still decides which models the endpoint offers.',
      modelsReset: 'Reset to the shipped catalog',
      overridden: 'Overridden',
      reset: 'Reset',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      saved: 'Applied. The route uses these values without a restart.',
      failedSettings: 'The deployment did not accept these values; they were left for you to correct.',
      failedCredential: 'The endpoint and model overrides were applied, but the API key was not stored. Check the key and save again.',
      invalidJson: 'Not valid JSON.',
      invalidList: 'Must be a JSON array of model objects.',
      invalidEntry: 'Entry {index} must be an object.',
      invalidId: 'Entry {index} needs a non-empty string "id".',
      invalidDuplicate: 'Entry {index} repeats the id "{id}".',
      invalidCapacity: 'Entry {index} has an invalid "{field}"; it must be a positive whole number.',
      invalidInput: 'Entry {index} has an invalid "input"; it must be a non-empty list of "text" or "image".',
      invalidReasoning: 'Entry {index} has an invalid "reasoning"; it must be true or false.',
      keyBlank: 'The key cannot be only whitespace.',
      keyIllegalCharacters: 'A key is printable ASCII with no spaces; this looks like a pasted environment line or a quoted value.',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      loading: 'Reading the current configuration…',
    }

    const zh = {
      title: 'Aliyun DashScope 连接',
      endpoint: '接入点',
      endpointHint: 'OpenAI 兼容的 base URL。百炼工作空间域名也可以；模型列表来自 {endpoint}/models。',
      endpointPlaceholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'API Key',
      apiKeyHint: '以只写方式保存为 {ref}。留空表示保留已保存的 Key。',
      apiKeyRefNote: '模型页面从不询问引用名；它由本插件提供，读取的是 {ref}。',
      keyStored: '已保存',
      keyMissing: '未设置',
      models: '模型覆盖',
      modelsHint: '以 JSON 表示的固定列表。此处列出的模型一定会被公开，并保留此处写下的容量；具体端点提供哪些模型仍由发现决定。',
      modelsReset: '恢复为内置目录',
      overridden: '已覆盖',
      reset: '重置',
      save: '保存',
      saving: '保存中…',
      discard: '放弃',
      saved: '已应用。该路由无需重启即可使用这些值。',
      failedSettings: '本部署没有接受这些值，已保留供你修改。',
      failedCredential: '接入点与模型覆盖已应用，但 API Key 未能保存。请检查 Key 后再次保存。',
      invalidJson: '不是合法的 JSON。',
      invalidList: '必须是模型对象组成的 JSON 数组。',
      invalidEntry: '第 {index} 项必须是对象。',
      invalidId: '第 {index} 项需要非空的字符串 "id"。',
      invalidDuplicate: '第 {index} 项重复了 id "{id}"。',
      invalidCapacity: '第 {index} 项的 "{field}" 不合法；必须是正整数。',
      invalidInput: '第 {index} 项的 "input" 不合法；必须是 "text" 或 "image" 组成的非空列表。',
      invalidReasoning: '第 {index} 项的 "reasoning" 不合法；必须是 true 或 false。',
      keyBlank: 'Key 不能只有空白字符。',
      keyIllegalCharacters: 'Key 应为不带空格的可打印 ASCII；当前值像是粘贴的环境变量行或带引号的值。',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未加载，暂时无法配置。',
      loading: '正在读取当前配置…',
    }

    /**
     * Fill the {name} placeholders in one copy string.
     * @param {string} template - the copy.
     * @param {Record<string, string | number>} [values] - the substitutions.
     * @returns {string} the rendered copy.
     */
    function format(template, values = {}) {
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match))
    }

    /**
     * The stylesheet, as one string.
     *
     * Only `--dsw-alias-*` tokens, radii, and the focus ring are referenced, so a
     * renamed token degrades this card's appearance rather than breaking it, and
     * light/dark switching comes for free. The markup and spacing follow the
     * host's own settings form, because a plugin's page reads as one application
     * with the pages around it.
     */
    const STYLES = `
.dsh-aliyun-card{display:flex;flex-direction:column;gap:2px;margin-top:4px}
.dsh-aliyun-note{margin:0 0 4px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dsh-aliyun-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}
.dsh-aliyun-field + .dsh-aliyun-field{border-top:.5px solid var(--dsw-alias-border-l2)}
.dsh-aliyun-head{display:flex;align-items:center;gap:8px}
.dsh-aliyun-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dsh-aliyun-badges{display:inline-flex;align-items:center;gap:8px}
.dsh-aliyun-badge{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary);padding:1px 6px;font-size:11px;line-height:16px}
.dsh-aliyun-badge[data-tone='quiet']{color:var(--dsw-alias-label-tertiary)}
.dsh-aliyun-badge[data-tone='ok']{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dsh-aliyun-reset{border:none;background:none;padding:0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-aliyun-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dsh-aliyun-reset:disabled{cursor:default}
.dsh-aliyun-input,.dsh-aliyun-textarea{box-sizing:border-box;width:100%;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dsh-aliyun-input{height:34px}
.dsh-aliyun-textarea{min-height:150px;padding:8px 12px;resize:vertical;font-family:var(--dsw-font-markdown-code-font-family);font-size:12px}
.dsh-aliyun-input:focus-visible,.dsh-aliyun-textarea:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.dsh-aliyun-input:disabled,.dsh-aliyun-textarea:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.dsh-aliyun-input[aria-invalid='true'],.dsh-aliyun-textarea[aria-invalid='true']{border-color:var(--dsw-alias-state-error-primary)}
.dsh-aliyun-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dsh-aliyun-invalid{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}
.dsh-aliyun-footer{display:flex;align-items:center;gap:8px;padding-top:16px}
.dsh-aliyun-status{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5}
.dsh-aliyun-status[data-tone='ok']{color:var(--dsw-alias-state-success-primary)}
.dsh-aliyun-status[data-tone='error']{color:var(--dsw-alias-state-error-primary)}
.dsh-aliyun-status[data-tone='quiet']{color:var(--dsw-alias-label-tertiary)}
.dsh-aliyun-button{appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md);padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer}
.dsh-aliyun-button:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsh-aliyun-button:disabled{opacity:.4;cursor:default}
.dsh-aliyun-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dsh-aliyun-secondary{background:transparent;border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary)}
.dsh-aliyun-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
`

    /**
     * Install the stylesheet once per page, tagged so a second mount of this
     * plugin adopts the tag already there instead of stacking another.
     * @returns {HTMLStyleElement | undefined} the tag, when there is a document.
     */
    function installStyles() {
      if (typeof document === 'undefined') return undefined
      const tagId = '@doitian/dsh-provider-aliyun/client.css'
      const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`)
      if (existing !== null) return undefined
      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', tagId)
      style.textContent = STYLES
      document.head.append(style)
      return style
    }

    /** Whether a value is a plain object. */
    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    /**
     * The credential reference this route resolves keys through.
     *
     * The profile's own `apiKeyEnv` wins, because a deployment may have pointed
     * the route at a different store; the derivation below is the same one the
     * Models page uses for a provider that names none.
     *
     * @param {string} route - the provider route.
     * @returns {string} the reference name.
     */
    function deriveKeyRef(route) {
      return `${String(route).replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_API_KEY`
    }

    /**
     * A minimal observable store.
     *
     * The card needs exactly one thing from a store library — a snapshot that
     * changes identity when the projection does, and listeners to tell — and
     * taking it from here rather than from a harness package keeps this module
     * dependent on nothing whose shape can move.
     *
     * @param {object} initial - the first snapshot.
     * @returns {object} the store.
     */
    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set(next) {
          snapshot = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /**
     * Judge the API-key draft, mirroring what the host will accept.
     *
     * A blank field is not a failure: every card opens blank even when a key is
     * already stored, where blank means keep it. Only a draft that is *some*
     * input and still unusable is refused here, so the failure is reported beside
     * the field rather than as a rejected write.
     *
     * @param {string} draft - the untrimmed field value.
     * @returns {string | undefined} the copy key for a failure, or nothing.
     */
    function apiKeyFailure(draft) {
      if (draft.length === 0) return undefined
      const value = draft.trim()
      if (value.length === 0) return 'keyBlank'
      if (ENV_LINE.test(value) || !LEGAL_API_KEY.test(value)) return 'keyIllegalCharacters'
      return undefined
    }

    /**
     * Validate the model-override draft locally.
     *
     * An empty draft is not a failure: emptying a control and saving is the same
     * gesture as resetting it, which is exactly what **Reset to the shipped
     * catalog** stages. Refusing it here would leave the reset with no way to
     * complete — the field would read "not valid JSON" and the save would stay
     * disabled, so the override could be neither cleared nor corrected.
     *
     * The host's schema is the authority; this only spares the user a round trip
     * to be told the same thing, and it mirrors `modelSchema` in `lib/index.js`
     * field for field. Server-side validation still decides.
     *
     * @param {string} text - the textarea contents.
     * @returns {{ kind: string, values?: object } | undefined} a failure, or nothing.
     */
    function modelsFailure(text) {
      if (text.trim().length === 0) return undefined
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        return { kind: 'invalidJson' }
      }
      if (!Array.isArray(parsed)) return { kind: 'invalidList' }
      const seen = new Set()
      for (const [index, entry] of parsed.entries()) {
        const at = index + 1
        if (!isRecord(entry)) return { kind: 'invalidEntry', values: { index: at } }
        if (typeof entry.id !== 'string' || entry.id.trim().length === 0) {
          return { kind: 'invalidId', values: { index: at } }
        }
        if (seen.has(entry.id)) return { kind: 'invalidDuplicate', values: { index: at, id: entry.id } }
        seen.add(entry.id)
        for (const field of ['contextWindow', 'maxTokens']) {
          const value = entry[field]
          if (value !== undefined && !(Number.isInteger(value) && value > 0)) {
            return { kind: 'invalidCapacity', values: { index: at, field } }
          }
        }
        if (entry.input !== undefined) {
          const ok = Array.isArray(entry.input) && entry.input.length > 0
            && entry.input.every((modality) => modality === 'text' || modality === 'image')
          if (!ok) return { kind: 'invalidInput', values: { index: at } }
        }
        if (entry.reasoning !== undefined && typeof entry.reasoning !== 'boolean') {
          return { kind: 'invalidReasoning', values: { index: at } }
        }
      }
      return undefined
    }

    /**
     * One card's staged edits over the `llm-aliyun` settings namespace.
     *
     * Writes are staged and committed on Save, because each one is a durable,
     * revision-fenced document mutation: a draft that never landed has to stay
     * visible so the user can correct it rather than retype it.
     */
    class AliyunCardController {
      /**
       * @param {object} ctx - the browser plugin context.
       */
      constructor(ctx) {
        this.ctx = ctx
        this.scope = ctx.configForms.get(SETTINGS_NS)
        /** Staged text per field, absent when the field still shows the stored value. */
        this.staged = new Map()
        /** The write-only API-key draft; never read back from anywhere. */
        this.keyDraft = ''
        /** Whether a key is stored under the reference, as the host reports it. */
        this.keyConfigured = undefined
        this.saving = false
        /** Which stage of the last save failed, as a copy key, or nothing. */
        this.failure = undefined
        this.saved = false
        this.unsubscribe = this.scope.subscribe(() => this.publish())
        this.store = createStore(this.projection())
        this.refreshCredential()
      }

      /** The reference this card stores a key under, from the live profile. */
      keyRef() {
        const profile = this.sectionValue()
        const named = isRecord(profile) ? profile.apiKeyEnv : undefined
        return typeof named === 'string' && named.trim().length > 0 ? named.trim() : deriveKeyRef(ROUTE)
      }

      /** The live accepted section, as the host serves it. */
      sectionValue() {
        const value = this.scope.getSnapshot().value
        return isRecord(value) ? value : {}
      }

      /** Whether the stored user layer carries this field. */
      stored(name) {
        const user = this.scope.getSnapshot().user
        return isRecord(user) && Object.hasOwn(user, name)
      }

      /**
       * Read one control's state, in the shape the controls render.
       * @param {string} name - the field name.
       * @returns {{ text: string, overridden: boolean, invalid: boolean, failure?: object }} the control state.
       */
      field(name) {
        const staged = this.staged.get(name)
        if (staged === undefined) {
          return { text: this.formatField(name, this.sectionValue()[name]), overridden: this.stored(name), invalid: false }
        }
        const failure = this.failureOf(name, staged)
        return {
          text: staged,
          // A staged clear is still an override while the user layer carries the
          // field, so the reset affordance does not vanish mid-edit.
          overridden: staged.trim().length > 0 || this.stored(name),
          invalid: failure !== undefined,
          failure,
        }
      }

      /** The editable text for one stored value. */
      formatField(name, value) {
        if (name === 'models') return Array.isArray(value) ? JSON.stringify(value, null, 2) : ''
        return typeof value === 'string' ? value : ''
      }

      /** Whether a staged draft would be refused, and why. */
      failureOf(name, text) {
        return name === 'models' ? modelsFailure(text) : undefined
      }

      /** Ask the host whether a credential is stored, and republish. */
      refreshCredential() {
        const ref = this.keyRef()
        // Deferred into the promise chain on purpose: a wire namespace that is
        // not answering throws synchronously, and this runs from the controller's
        // constructor, where a throw would take the whole card down.
        Promise.resolve()
          .then(() => this.ctx.remote.credentials.describe([ref]))
          .then((response) => {
            if (this.disposed === true) return
            const info = response?.ok === true ? response.value?.[ref] : undefined
            this.keyConfigured = isRecord(info) ? info.configured === true : undefined
            this.publish()
          })
          .catch(() => {
            if (this.disposed === true) return
            this.keyConfigured = undefined
            this.publish()
          })
      }

      /**
       * Every write a save would issue, or `undefined` when a draft is unusable.
       *
       * The paths are top-level and the whole `models` array is written at once,
       * because that is what the host stores: one replace-by-value array, not a
       * per-model patch — so clearing a field is an `unset` back to the
       * composition layer rather than an empty value.
       *
       * @returns {object[] | undefined} the ordered path ops.
       */
      plan() {
        const ops = []
        for (const name of FIELDS) {
          const staged = this.staged.get(name)
          if (staged === undefined) continue
          if (this.failureOf(name, staged) !== undefined) return undefined
          const trimmed = staged.trim()
          if (trimmed.length === 0) {
            if (this.stored(name)) ops.push({ op: 'unset', path: [name] })
            continue
          }
          if (name === 'models') ops.push({ op: 'set', path: [name], value: JSON.parse(trimmed) })
          else ops.push({ op: 'set', path: [name], value: trimmed })
        }
        return ops
      }

      /** Whether a save would write anything. */
      dirty() {
        return this.staged.size > 0 || this.keyDraft.trim().length > 0
      }

      /**
       * Whether a save would write anything at all.
       *
       * Reset on a field the user layer does not carry stages a draft that turns
       * into no path op, so the button follows the *plan* rather than the draft:
       * otherwise it would offer a save that does nothing.
       */
      actionable(plan) {
        return plan !== undefined && (plan.length > 0 || this.keyDraft.trim().length > 0)
      }

      /** The snapshot every render reads. */
      projection() {
        const snapshot = this.scope.getSnapshot()
        const loading = snapshot.status === 'loading'
        const available = snapshot.status === 'ready'
        const keyFailure = apiKeyFailure(this.keyDraft)
        const plan = this.plan()
        return {
          loading,
          available,
          writable: snapshot.writable === true,
          dirty: this.dirty(),
          canSave: available
            && snapshot.writable === true
            && !this.saving
            && keyFailure === undefined
            && this.actionable(plan),
          saving: this.saving,
          failure: this.failure,
          failed: this.failure !== undefined,
          saved: this.saved,
          keyRef: this.keyRef(),
          keyConfigured: this.keyConfigured,
          key: { text: this.keyDraft, invalid: keyFailure !== undefined },
          keyFailure,
          fields: Object.fromEntries(FIELDS.map((name) => [name, this.field(name)])),
        }
      }

      /** Republish the projection to every reader. */
      publish() {
        if (this.disposed === true) return
        this.store.set(this.projection())
      }

      /**
       * The face this card's slot entry injects.
       * @returns {object} the store handle and the form actions.
       */
      inject() {
        return {
          hooks: { aliyunCard: this.store },
          edit: (name, text) => {
            this.saved = false
            this.failure = undefined
            this.staged.set(name, text)
            this.publish()
          },
          resetField: (name) => {
            // An empty draft is the whole edit: the save below turns it into the
            // `unset` that drops the override.
            this.saved = false
            this.failure = undefined
            this.staged.set(name, '')
            this.publish()
          },
          editKey: (text) => {
            this.saved = false
            this.failure = undefined
            this.keyDraft = text
            this.publish()
          },
          discard: () => {
            if (!this.dirty() && this.failure === undefined) return
            this.staged.clear()
            this.keyDraft = ''
            this.failure = undefined
            this.saved = false
            this.publish()
          },
          save: () => this.save(),
        }
      }

      /**
       * Write every staged edit, then the credential, then re-read the section.
       *
       * The settings write goes first so the card adopts the returned revision
       * before the credential stage. The two stages report *separately*, because a
       * key the host refused does not mean the endpoint was not saved: one message
       * for both would send the user back to retype values that already landed.
       */
      async save() {
        const ops = this.plan()
        const key = this.keyDraft.trim()
        if (this.saving || ops === undefined || apiKeyFailure(this.keyDraft) !== undefined) return
        if (ops.length === 0 && key.length === 0) return
        this.saving = true
        this.saved = false
        this.failure = undefined
        this.publish()
        try {
          if (!await this.writeSettings(ops)) {
            // Nothing landed, so the drafts stay for correction.
            this.failure = 'failedSettings'
            return
          }
          // The section landed, so those drafts are settled even if the key is
          // not; the key draft stays so a second save offers only that stage.
          this.staged.clear()

          if (key.length > 0 && !await this.storeCredential(key)) {
            this.failure = 'failedCredential'
            return
          }
          if (key.length > 0) this.keyDraft = ''
          this.saved = true
          this.refreshCredential()
        } catch {
          this.failure = this.failure ?? 'failedSettings'
        } finally {
          this.saving = false
          this.publish()
        }
      }

      /**
       * Write the staged path ops, retrying once against a fresh fence.
       *
       * A first attempt can lose a race the user did not cause: the host rewrites
       * this section for its own writes, and a revision this card read before that
       * landed is refused as a conflict even though the intent is still valid. The
       * scope reloads its state on such a refusal, so one retry without an explicit
       * fence — the scope's own pending-or-current revision — is what makes Save
       * mean "make it so" rather than "make it so if nothing moved meanwhile".
       *
       * @param {object[]} ops - the ordered path ops.
       * @returns {Promise<boolean>} whether the host accepted them.
       */
      async writeSettings(ops) {
        if (ops.length === 0) return true
        if (await this.scope.mutate(ops, this.scope.getSnapshot().revision)) return true
        return await this.scope.mutate(ops)
      }

      /**
       * Store the key under this route's reference.
       * @param {string} key - the trimmed key.
       * @returns {Promise<boolean>} whether the host accepted it.
       */
      async storeCredential(key) {
        const response = await this.ctx.remote.credentials.set(this.keyRef(), key)
        return response?.ok === true
      }

      /** Stop watching the scope. */
      dispose() {
        this.disposed = true
        this.unsubscribe()
      }
    }

    /**
     * One labelled control.
     * @param {object} props - the control's copy, state, and its edit actions.
     * @returns {object} the rendered field.
     */
    function Field(props) {
      const { id, label, hint, value, disabled, invalid, failureText, overriddenLabel, resetLabel, multiline, onEdit, onReset } = props
      const describedBy = invalid || hint !== undefined ? `${id}-message` : undefined
      return h('div', { className: 'dsh-aliyun-field' }, [
        h('div', { className: 'dsh-aliyun-head', key: 'head' }, [
          h('label', { className: 'dsh-aliyun-label', htmlFor: id, key: 'label' }, label),
          value.overridden ? h('span', { className: 'dsh-aliyun-badges', key: 'badges' }, [
            h('span', { className: 'dsh-aliyun-badge', key: 'overridden' }, overriddenLabel),
            h('button', {
              type: 'button',
              className: 'dsh-aliyun-reset',
              disabled,
              onClick: onReset,
              key: 'reset',
            }, resetLabel),
          ]) : null,
        ]),
        multiline
          ? h('textarea', {
            id,
            key: 'control',
            className: 'dsh-aliyun-textarea',
            spellCheck: false,
            value: value.text,
            disabled,
            'aria-invalid': invalid || undefined,
            'aria-describedby': describedBy,
            onChange: (event) => onEdit(event.target.value),
          })
          : h('input', {
            id,
            key: 'control',
            className: 'dsh-aliyun-input',
            type: 'text',
            value: value.text,
            disabled,
            'aria-invalid': invalid || undefined,
            'aria-describedby': describedBy,
            onChange: (event) => onEdit(event.target.value),
          }),
        invalid
          ? h('p', { className: 'dsh-aliyun-invalid', id: `${id}-message`, key: 'message' }, failureText)
          : hint !== undefined
            ? h('p', { className: 'dsh-aliyun-hint', id: `${id}-message`, key: 'message' }, hint)
            : null,
      ])
    }

    /**
     * The card itself.
     *
     * Props arrive from three places: the slot's owner (the row's provider view,
     * its configured state, and its credential state), this registration's
     * `inject` face (the snapshot hook and the form actions), and the
     * registration's `locale` namespace (the copy reader).
     *
     * @param {object} props - the composed props.
     * @returns {object} the rendered card.
     */
    function AliyunCard(props) {
      const { t } = props
      const state = props.useAliyunCard((snapshot) => snapshot)
      const endpoint = state.fields.baseURL
      const models = state.fields.models

      const failureText = (failure) => {
        if (failure === undefined) return undefined
        return format(t(failure.kind), failure.values ?? {})
      }

      return h('div', { className: 'dsh-aliyun-card' }, [
        state.loading
          ? h('p', { className: 'dsh-aliyun-note', key: 'loading' }, t('loading'))
          : null,
        !state.available && !state.loading
          ? h('p', { className: 'dsh-aliyun-note', key: 'unavailable' }, t('unavailable'))
          : null,
        state.available && !state.writable
          ? h('p', { className: 'dsh-aliyun-note', key: 'readOnly' }, t('readOnly'))
          : null,

        state.available ? h(Field, {
          key: 'endpoint',
          id: 'dsh-aliyun-endpoint',
          label: t('endpoint'),
          // An empty field means the schema default is in force, so the hint
          // names that default rather than leaving the sentence half-built.
          hint: format(t('endpointHint'), {
            endpoint: endpoint.text.trim().length > 0 ? endpoint.text.trim() : t('endpointPlaceholder'),
          }),
          value: endpoint,
          disabled: !state.writable || state.saving,
          invalid: endpoint.invalid,
          failureText: failureText(endpoint.failure),
          overriddenLabel: t('overridden'),
          resetLabel: t('reset'),
          onEdit: (text) => props.edit('baseURL', text),
          onReset: () => props.resetField('baseURL'),
        }) : null,

        state.available ? h('div', { className: 'dsh-aliyun-field', key: 'key' }, [
          h('div', { className: 'dsh-aliyun-head', key: 'head' }, [
            h('label', { className: 'dsh-aliyun-label', htmlFor: 'dsh-aliyun-key', key: 'label' }, t('apiKey')),
            h('span', { className: 'dsh-aliyun-badges', key: 'badges' }, [
              h('span', {
                className: 'dsh-aliyun-badge',
                'data-tone': state.keyConfigured === true ? 'ok' : 'quiet',
                key: 'state',
              }, state.keyConfigured === true ? t('keyStored') : t('keyMissing')),
            ]),
          ]),
          h('input', {
            id: 'dsh-aliyun-key',
            key: 'control',
            className: 'dsh-aliyun-input',
            type: 'password',
            autoComplete: 'new-password',
            value: state.key.text,
            disabled: !state.writable || state.saving,
            'aria-invalid': state.key.invalid || undefined,
            'aria-describedby': 'dsh-aliyun-key-message',
            onChange: (event) => props.editKey(event.target.value),
          }),
          h('p', {
            className: state.key.invalid ? 'dsh-aliyun-invalid' : 'dsh-aliyun-hint',
            id: 'dsh-aliyun-key-message',
            key: 'message',
          }, state.key.invalid
            ? t(state.keyFailure)
            : `${format(t('apiKeyHint'), { ref: state.keyRef })} ${format(t('apiKeyRefNote'), { ref: state.keyRef })}`),
        ]) : null,

        state.available ? h(Field, {
          key: 'models',
          id: 'dsh-aliyun-models',
          label: t('models'),
          hint: t('modelsHint'),
          value: models,
          disabled: !state.writable || state.saving,
          invalid: models.invalid,
          failureText: failureText(models.failure),
          overriddenLabel: t('overridden'),
          resetLabel: t('modelsReset'),
          multiline: true,
          onEdit: (text) => props.edit('models', text),
          onReset: () => props.resetField('models'),
        }) : null,

        state.available ? h('div', { className: 'dsh-aliyun-footer', key: 'footer' }, [
          h('p', {
            className: 'dsh-aliyun-status',
            key: 'status',
            role: 'status',
            'aria-live': 'polite',
            'data-tone': state.failed ? 'error' : state.saved ? 'ok' : 'quiet',
          }, state.failure !== undefined ? t(state.failure) : state.saved ? t('saved') : ''),
          h('button', {
            type: 'button',
            className: 'dsh-aliyun-button dsh-aliyun-secondary',
            key: 'discard',
            disabled: !state.dirty || state.saving,
            onClick: props.discard,
          }, t('discard')),
          h('button', {
            type: 'button',
            className: 'dsh-aliyun-button dsh-aliyun-primary',
            key: 'save',
            disabled: !state.canSave,
            onClick: props.save,
          }, state.saving ? t('saving') : t('save')),
        ]) : null,
      ])
    }

    /** Required client services, resolved before `apply` runs. */
    const inject = ['slots', 'locale', 'configForms', 'remote.credentials']

    /**
     * Register the card against this plugin's own Models-page row.
     * @param {object} ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(COPY_NS)
      ctx.effect(() => ctx.locale.register(COPY_NS, { en, zh }), 'llm-aliyun: card copy')
      ctx.effect(() => {
        const style = installStyles()
        return () => style?.remove()
      }, 'llm-aliyun: card styles')

      const card = new AliyunCardController(ctx)
      ctx.effect(() => () => card.dispose(), 'llm-aliyun: card controller')

      // The seat is declared by the Models page, and it is declared for every row
      // it renders; registering through `inject` waits for that declaration and
      // is disposed with it. `whileServed` keeps the whole card absent until the
      // host actually serves this namespace, so a deployment without this plugin
      // shows no trace of it.
      ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
        name: 'settings.models.provider-card',
        key: SETTINGS_NS,
        locale: COPY_NS,
        inject: () => card.inject(),
      }, AliyunCard))), 'llm-aliyun: Models-page card')
    }

    return { inject, apply }
  },
})
