# Pi oMLX Extension

Dynamic oMLX model discovery and reasoning-level integration for Pi. Repository: `pi-omlx-extension`; package/extension name: `pi-omlx-model-picker`; provider ID: `omlx`.

Two features, both built on Pi's native provider architecture:

1. **Dynamic model refresh** — Pi's own `/model` selector shows what oMLX currently has. Installed models appear, removed models disappear, no Pi restart.
2. **Model-specific reasoning effort** — each model's reasoning controls are read from oMLX, only supported levels appear in Pi's native thinking selector, and the selected level reaches the request body. Visible thinking output is preserved.

No commands, no custom UI, no credentials, no config files, no automatic level switching, no model loading/unloading. Only `GET` requests.

```
pi-omlx-model-picker.ts         register `omlx` as a dynamic provider with refreshModels
src/omlx.ts                     oMLX catalog read, chat-model filter, capability → thinkingLevelMap
test/omlx.test.ts               catalog + capability unit tests
test/extension.test.ts          refresh phases, add/remove, credential, failure, persisted catalog, publication and cancellation rules
test/pi-integration.test.ts     against Pi's own provider composer, thinking selector, and request builder
test/startup.test.ts            Pi's real startup path: services → session → model, across restarts
test/fixtures/omlx-status.ts    /v1/models/status fixtures for several capability shapes
scripts/verify-omlx.ts          read-only live verification (optionally probing inference)
```

## 1. Dynamic refresh

`pi.registerProvider("omlx", { name, api: "openai-completions", authHeader: true, refreshModels })` — the same dynamic-provider mechanism Pi's built-in llama.cpp extension uses (`dist/extensions/llama/provider.js`), expressed through Pi's documented extension API. Pi calls `refreshModels` on every catalog refresh: at startup, each time `/model` is opened (shared request, 15 s timeout, selector rebuilt from the refreshed snapshot), and on any `modelRegistry.refresh()`.

Pi supplies both phases, and the extension answers them like this:

| Phase | Behavior |
|---|---|
| offline (`allowNetwork: false`, `PI_OFFLINE=1`) | returns the catalog this process last read, or the one Pi persisted for `omlx` — re-stamped with the base URL Pi is configured with now; no network. Returns nothing when neither exists, so Pi's existing state stays intact |
| network, Pi has an `omlx` key | `GET {baseUrl}/v1/models/status` → filtered, capability-mapped list, published in memory and handed to Pi's store via `context.publish({ persist })`; a publication Pi rejects (a newer refresh won) is applied nowhere |
| network, no key configured | returns unchanged: the extension does not create credentials or logins |
| request failure | rejects, so Pi reports it in `/model`; because the list is only published after a successful read, the previous catalog survives |

### Why the offline phase publishes anything

Pi's startup order decides what the session starts with:

```
ModelRuntime.create · registerProvider · createAgentSessionServices   →  refresh, allowNetwork: false
createAgentSession                                                   →  resolve model, thinking level, /model list
InteractiveMode.run                                                  →  background network refresh
```

Only the offline phase runs before Pi resolves the selected model, clamps the saved thinking level, and builds the scoped model list. If it returns nothing, Pi resolves `models.json`'s static `models` entry and keeps that model object for the whole session — with `reasoning: false` there, Pi calls the model non-reasoning, pins the level to `off`, and refuses to change it. The interactive refresh corrects the catalog seconds later, but not the model the session already holds, which is why reselecting in `/model` appeared to fix it.

So the offline phase publishes the discovered capabilities itself: this process's last read, or the entry Pi persisted for the provider (`context.stored`, `~/.pi/agent/models-store.json`) — the same mechanism Pi's llama.cpp extension uses. A restored definition is re-stamped with the base URL Pi composed for this refresh: Pi honors a model's own `baseUrl` above the provider URL from `models.json`, so an unrestamped snapshot would keep talking to a retired host or port until the network read replaced it. The extension never writes that file: it hands the catalog to Pi through `context.publish({ persist })`, and Pi owns the file, its schema, and its removal. `models.json` is never written, and its static entry stays harmless because Pi applies extension-provided definitions above `models.json` `models` entries. Each successful read replaces the entry, so a model removed from oMLX does not resurface on the next start (asserted in `test/startup.test.ts`). Unlike llama.cpp, which reads unloaded models' chat templates lazily because llama reports templates only for loaded engines, oMLX reports every model's reasoning vocabulary in one catalog response, loaded or not, so unloaded oMLX models keep their full level list.

## 2. Reasoning controls from oMLX

`GET /v1/models/status` (one endpoint for both features) carries, per model:

| field | meaning in oMLX |
|---|---|
| `reasoning_efforts` | effort names the model's own chat template accepts, detected by `model_discovery.detect_reasoning_effort` from a subset of `low, medium, high, xhigh, max`. `null` = the template does not read `reasoning_effort`; `[]` = it reads it but names none |
| `thinking_default` | non-null when oMLX has a thinking on/off switch for the model |
| `is_helper` | speculative drafter (dFlash/MTP) |
| `is_hidden` | hidden in oMLX |
| `model_type`, `engine_type`, `realtime_*` | service kind, chat vs non-chat |
| `max_context_window`, `model_context_length`, `max_tokens` | limits |

Levels follow oMLX's reasoning slider (`admin/routes.reasoning_levels`), including its family-specific overrides for DeepSeek V4/V4.1, GPT-OSS, K2 Horizon, and MiniMax M3. Pi displays only levels it supports:

| oMLX reports | Pi levels |
|---|---|
| `thinking_default` set + `reasoning_efforts: ["low","medium","high","xhigh"]` | `off, low, medium, high, xhigh` |
| `reasoning_efforts: ["low","medium","xhigh"]` | `off, low, medium, xhigh` (`high` removed, not remapped) |
| `reasoning_efforts` includes `max` | `max` offered too (Pi hides `xhigh`/`max` unless stated explicitly) |
| `thinking_default` set + `reasoning_efforts: null` | `off, low` with `supportsReasoningEffort: false` — one thinking level, no depth dial |
| `thinking_default: null` + efforts present | no `off` level, because oMLX offers none either |
| `reasoning_efforts: []` | oMLX's canonical dial `low…max` |
| both null | `reasoning: false`, Pi offers `off` only and sends no thinking parameters |

`minimal` is never offered (oMLX has no such name). Names oMLX reports that Pi cannot express are dropped rather than approximated.

**On the wire.** Reasoning models are registered with `compat.thinkingFormat: "qwen"`, which makes Pi's OpenAI-completions builder send oMLX's own request fields; oMLX normalizes `enable_thinking` into `chat_template_kwargs` for every family itself and forwards `reasoning_effort` to the template:

```jsonc
{ "model": "...", "enable_thinking": false }                                    // off
{ "model": "...", "enable_thinking": true, "reasoning_effort": "xhigh" }       // thinking on at that depth
{ "model": "...", "enable_thinking": true }                                     // thinking model without a depth dial
```

Unsupported levels never need patching: `clampThinkingLevel` runs inside Pi's request builder, so Pi clamps to the model's own vocabulary before the payload exists. Verified live below (`!` marks a clamped request). Other compat flags follow oMLX's request schema: `maxTokensField: "max_tokens"`, `supportsReasoningEffort` per model, `supportsStore/supportsDeveloperRole/supportsStrictMode: false`, `supportsUsageInStreaming: true`.

**Filtering** is metadata-only: `is_helper`, `is_hidden`, `realtime_voice`/`realtime_stt`, and oMLX's non-chat service types (`markitdown`, `embedding*`, `reranker`, `audio_*`, `decision`) are dropped. An oMLX model type this extension has never seen is kept when oMLX reports chat limits for it, so a new chat family is not excluded by an out-of-date type list. Limits come from the tightest reported value; `max_tokens` is capped by the context window; `model_type: "vlm"` ⇒ `input: ["text","image"]`; `engine_type` alone is not sufficient because oMLX can run text-only models on its VLM engine.

## Credentials

The extension adds none. It sends no key of its own: Pi composes the provider from its existing `omlx` entry in `~/.pi/agent/models.json` (`apiKey` + `authHeader`) or a credential stored via Pi's own `/login`, and passes that resolved credential and base URL into `refreshModels`. `/model` inference and the catalog read therefore use the same key. A credential-resolution test asserts the key source is `configured API key` and that it becomes `Authorization: Bearer …`. Error messages never repeat the key. A stale manual `models` entry in `models.json` cannot weaken the discovered capabilities: Pi applies extension-provided model definitions above `models.json` `models` entries (only `api`/`baseUrl` fall back), while `modelOverrides` remain a deliberate user override layer.

## Verify

```bash
npm test          # 46 tests: 18 unit + 14 extension refresh/publication + 8 against Pi's real provider composer / thinking selector / request builder + 6 against Pi's real startup path
npm run typecheck # tsc -p tsconfig.json against the shipped code (needs a tsc on PATH, e.g. `npx -p typescript tsc -p tsconfig.json`; none is vendored here)
npm run check     # read-only: live catalog, filtered entries, and the exact payload Pi sends per level
npm run check:live # additionally runs one short completion per level on a model oMLX already has loaded
```

Example output captured during development (available models and levels will differ):

```text
oMLX  http://127.0.0.1:8000/v1   (base URL from ~/.pi/agent/models.json)
API key: configured API key [value not shown]

Pi /model catalog (4 chat models)
  Qwen3.8-27B-pi-Q8_0                     [text+image]  ctx 262144, max 65536   off, low, medium, xhigh
  Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS      [text+image]  ctx 262144, max 65536   off, low, medium, high, xhigh
  Qwen3.8-Flash-Next-GSQ-RCO-Q2_0         [text+image]  ctx 262144, max 65536   off, low, medium, high, xhigh
  ThinkingCap-Qwen3.8-27B-Q8_0            [text+image]  ctx 262144, max 65536   off, low, medium, xhigh
filtered out by oMLX metadata (3)
  - Qwen3.8-27B-DFlash2: helper model (draft/MTP)
  - Qwen3.8-Flash-Next-DFlash2: helper model (draft/MTP)
  - MarkItDown: model_type=markitdown
```

Payload plan Pi produces (identical for the other models; `!` = level Pi removes for that model):

```text
Qwen3.8-27B-pi-Q8_0  offered: off, low, medium, xhigh
     off     enable_thinking=false  reasoning_effort=null      off → no effort is sent
   ! minimal enable_thinking=true   reasoning_effort="low"
     medium  enable_thinking=true   reasoning_effort="medium"
   ! high    enable_thinking=true   reasoning_effort="xhigh"   'high' is not aliased by this extension
```

Live inference probe on the already-loaded model (`--probe`):

```text
   off     enable_thinking=false reasoning_effort=null     thinking     0 chars | answer "42"
  !minimal enable_thinking=true  reasoning_effort="low"    thinking    87 chars | answer "42"
   low     enable_thinking=true  reasoning_effort="low"    thinking    63 chars | answer "42"
   high    enable_thinking=true  reasoning_effort="high"   thinking   101 chars | answer "42"
  !max     enable_thinking=true  reasoning_effort="xhigh"  thinking   111 chars | answer "42"
   xhigh   enable_thinking=true  reasoning_effort="xhigh"  thinking   140 chars | answer "42"
```

Model add/remove is covered by automated refresh cycles (a changed `/v1/models/status` response changes Pi's catalog on the next refresh, including removal), because actually installing or deleting models would change oMLX's state, which is out of scope here.

## Try it

From the repository root, with the `omlx` provider already configured in Pi and the oMLX service running:

```bash
pi -e ./pi-omlx-model-picker.ts
```

Pi labels an extension by its entry file, which is why the entry point is `pi-omlx-model-picker.ts` and not a generic `index.ts`. `pi-omlx-model-picker.ts` imports `./src/omlx.ts`, so the `src` directory has to stay next to it. Installing permanently is your call, not done here:

- add this directory to the `extensions` array in `~/.pi/agent/settings.json` — Pi resolves a directory through the `pi.extensions` manifest in `package.json`, which points at `./pi-omlx-model-picker.ts`, so no `index.ts` is needed;
- or put this whole directory under `~/.pi/agent/extensions/pi-omlx-model-picker/` (same manifest, auto-discovered, reloadable with `/reload`).

## Repository development notes

- The extension is loaded directly from TypeScript and does not require compilation for Pi to run. The package is marked `private` because this repository is not being published to npm.
- Automated integration/startup tests and the verification script import Pi internal modules from `PI_PACKAGE_DIR` (defaulting to a Homebrew path). Run those checks with a compatible Pi installation at that path or set `PI_PACKAGE_DIR` as needed.
- The optional `typecheck` script currently resolves Pi typings through absolute Homebrew paths in `tsconfig.json`. Those paths must be adapted to a different installation layout before the typecheck is portable.
- No license is included yet. Public GitHub visibility does not itself grant permission to redistribute or modify the code; add an explicit license when you choose the terms.

## Limitations

- **Family-specific levels can change with oMLX updates.** The status endpoint reports checkpoint metadata rather than the admin slider's final levels. The extension mirrors the current oMLX exceptions for K2 Horizon, DeepSeek V4/V4.1, GPT-OSS, and MiniMax M3 without requiring admin access; new exception families may need a code update.
- **`/v1/models/status` is the only oMLX endpoint used.** If it is unavailable (older server build, auth failure), the catalog does not change and Pi surfaces the error; the extension does not guess a catalog from `/v1/models`, which lists drafters and non-chat services without their metadata.
- **Capabilities are known from the second run onward.** Pi resolves the session model before it reads oMLX over the network, so a process can only start from capabilities it already has. The first Pi run after installing the extension therefore uses `models.json`'s entry until its first successful read lands moments later (reopening `/model` or restarting settles it); every later start, including `PI_OFFLINE=1` and `/reload`, starts from the persisted capabilities. A saved snapshot is only ever replaced by a successful read, so it is at most one startup behind oMLX.
- **Pi's level vocabulary is fixed** (`off, minimal, low, medium, high, xhigh, max`); oMLX names outside it cannot be exposed, and Pi clamps removed levels to the nearest supported one.
- **Toggle-only models expose one thinking level** (`low`), since on/off has no depth to name.
- Costs are declared as zero, matching a local server.
- `thinking_budget` is not sent: Pi's thinking budgets are request-local token accounting, and oMLX budgets thinking inside the same `max_tokens`.
