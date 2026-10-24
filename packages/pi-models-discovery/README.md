# pi-models-discovery

Generic model discovery extension: reads providers marked with `"discoverModels": true` in `~/.pi/agent/models.json`, requests `GET {baseUrl}/models` (or a configured `modelsUrl`), and registers the discovered models automatically — no handwritten `models` array required. Discovered models appear in Pi's built-in `/model` picker. Each startup refreshes the endpoint list and configured metadata catalog, saves the JSON files automatically, and retains the last successful data on failure.

Suitable for local/self-hosted LLM proxies (one gateway exposing many models), Ollama, vLLM, and other OpenAI-compatible services.

## Install

```bash
pi install npm:pi-models-discovery
```

## Configuration

### Option 1: interactive configuration inside pi (recommended)

```
/config:model-discovery
```

Interactively add / remove / rediscover providers. The command opens a settings panel that lists every provider marked with `discoverModels`; selecting one opens its fields (enable/disable discovery, baseUrl, api type, apiKey, display name, model-list URL, metadata URL, metadata provider, model ID regex, per-model API JSON, startup refresh) plus actions to rediscover or remove it. Adding a provider asks for id, baseUrl, api type, apiKey (optional) and display name (optional). Changes are written to models.json and take effect **immediately** (no /reload required). A backup is written to `models.json.discovery-bak` before each write.

Note: comments and custom formatting in models.json are not preserved on write (the file is reformatted with 4-space indentation).

### Option 2: edit models.json by hand

Add `"discoverModels": true` to a provider in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "llm-proxy": {
      "name": "LLM Proxy",
      "baseUrl": "http://127.0.0.1:9000/pi/v1",
      "apiKey": "sk-1234",
      "api": "openai-completions",
      "discoverModels": true
    }
  }
}
```

`baseUrl` and `api` are required; `apiKey` is optional (omit for unauthenticated services). With metadata lookup disabled, providers sharing the same model-list URL, API type, `apiKey`, `headers`, and `compat` reuse a single discovery request. Metadata catalogs are shared by URL while each provider resolves its own matches.

If the model catalog uses a different endpoint, set the optional `modelsUrl` in models.json to its **complete URL** (including the path and any query parameters):

```json
{
  "providers": {
    "foo": {
      "baseUrl": "https://api.example.com/v1",
      "modelsUrl": "https://catalog.example.com/v1/models",
      "apiKey": "$FOO_API_KEY",
      "api": "openai-completions",
      "discoverModels": true
    }
  }
}
```

`modelsUrl` is used as-is for discovery and refresh only; chat requests still use `baseUrl`. When omitted or empty, discovery uses `{baseUrl}/models`. Discovery sends the provider's existing `apiKey` and `headers` to this URL, so use a trusted endpoint. The response format remains unchanged.

Hand edits require `/reload` to take effect; changes made through `/config:model-discovery` apply immediately.

### Shared model lists

Some gateways expose a model list through one protocol route while another route accepts inference but returns an empty list. Set `modelsUrl` to the shared list and `modelIdRegex` to a case-sensitive JavaScript regular expression to select the intended models:

```json
{
  "providers": {
    "messages-gateway": {
      "baseUrl": "https://api.example.com/anthropic",
      "modelsUrl": "https://api.example.com/openai/models",
      "modelIdRegex": "^claude-",
      "api": "anthropic-messages",
      "discoverModels": true,
      "metadataUrl": "https://models.dev/api.json",
      "metadataProvider": "anthropic"
    }
  }
}
```

The regex is optional; empty or omitted keeps all conversational models. Supply a JavaScript regex source without `/.../` delimiters or flags. Matching is case-sensitive and can occur anywhere in the ID; use `^` and `$` for anchors, for example `^claude-` or `^(claude-|gpt-)`. Escape backslashes in JSON: `"^model\\.v[0-9]+$"` matches IDs such as `model.v2`. Matching preserves the endpoint's exact ID, including case and whitespace.

Regex changes invalidate the model cache and take effect immediately in the settings panel. Invalid patterns are rejected by the panel; invalid file settings and filtered empty lists use the normal matching-cache/static fallback. The list URL does not change the inference URL or protocol. A shared list advertises models for the gateway; test a model with `/model_test` to confirm that it works on the selected route.

Existing `modelIdPrefix` settings are still read as literal prefixes and converted to escaped, anchored regexes. An explicit `modelIdRegex` takes precedence, including an empty string to disable filtering. Editing a provider in the settings panel saves the new field and removes `modelIdPrefix`; the first discovery after conversion refreshes the cache.

### Per-model API kind

Some gateways list every model on one route but only accept part of them there. Azure's `gpt-6.1-sol`, for example, rejects function tools combined with `reasoning_effort` on `/chat/completions` and requires `/responses`. Map model IDs to an API kind with `modelApi`; the key is a case-sensitive JavaScript regex source, the value overrides the provider `api` for matching models:

```json
{
  "providers": {
    "gateway": {
      "baseUrl": "https://api.example.com/openai",
      "api": "openai-completions",
      "discoverModels": true,
      "modelApi": { "^gpt-6": "openai-responses" }
    }
  }
}
```

The first matching pattern wins; unmatched models keep their endpoint-declared API or the provider `api`. An endpoint that advertises `capabilities.chat: false` with `capabilities.responses: true` already switches on its own when the provider uses `openai-completions`. Patterns follow the `modelIdRegex` rules, and `baseUrl` stays the same, so the route must serve both protocols. Confirm a switched model with `/model_test provider/model`.

Edit the same JSON object in the **Per-model API (JSON)** row of `/config:model-discovery`; changes apply immediately. Empty input clears the override. Invalid JSON, malformed maps, non-string or blank API values, and invalid patterns are rejected before saving.

Changing `modelApi` invalidates the model cache. Invalid file settings produce a warning and use only a cache matching the current configuration or handwritten `models`. An invalid edit cannot reuse the previous mapping's cache; without handwritten models, no discovered models are registered.

### Optional canonical metadata

The endpoint model list determines availability. To fill missing metadata from [models.dev](https://models.dev), add `metadataUrl` and optionally `metadataProvider` to the provider:

```json
{
  "providers": {
    "my-gateway": {
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "$GATEWAY_API_KEY",
      "api": "openai-completions",
      "discoverModels": true,
      "metadataUrl": "https://models.dev/api.json",
      "metadataProvider": "anthropic"
    }
  }
}
```

The plugin requests the gateway's `/models` list, then uses metadata for matching IDs in the catalog. For example, if the gateway lists `claude-sonnet-4-6`, its missing context limit, output limit, display name, modalities, reasoning flag and prices can come from the catalog's `anthropic` entry. Catalog-only models are never registered. Unknown endpoint models remain available with endpoint metadata and existing defaults.

| Field | Behavior |
| --- | --- |
| `metadataUrl` | Complete HTTP(S) catalog URL. Empty or omitted disables lookup and preserves endpoint-only discovery. Accepts the models.dev provider/model map, a model array, or `{ "data": [...] }` from a model-list API. Requests have a 5-second timeout. |
| `metadataProvider` | Optional exact provider ID in a models.dev catalog, such as `anthropic` or `openai`. Selects that provider only. It does not affect flat model-list catalogs. |

Without `metadataProvider`, matching tries the configured provider's exact ID, then a provider-qualified model ID (`anthropic/claude-sonnet-4-6`), then an exact model ID that appears in only one catalog provider. Ambiguous matches keep endpoint metadata and defaults; set `metadataProvider` to resolve them. Exact IDs take precedence. In a selected `anthropic` namespace (`metadataProvider: "anthropic"`, provider ID `anthropic`, or an `anthropic/`-qualified ID), Claude family IDs also match case differences and dots versus hyphens in numeric versions: `Claude-Sonnet-4.6` matches `claude-sonnet-4-6`. Versions and date suffixes are retained; ambiguous normalized matches are ignored. Other providers and flat catalogs keep exact matching. Chat requests keep the model ID returned by the endpoint.

**Precedence:** Pi's `modelOverrides` and the existing provider thinking configuration apply as before. For metadata fields, valid endpoint values win over catalog values, which win over defaults. Explicit `false` and zero prices are preserved, and prices merge per field. Catalog prices describe the selected catalog provider; a gateway may charge differently, so use endpoint pricing or `modelOverrides` for its actual rates. Endpoint `reasoning_options` take precedence over catalog controls. Missing controls can come from models.dev and enable extra thinking tiers; endpoint effort capabilities, explicit maps and your overrides still take precedence. The catalog describes the selected provider's controls; test actual gateway requests before relying on them.

Catalog requests never inherit the provider's API key or headers. A separate catalog API must permit unauthenticated reads. Lookup errors produce a warning and use the saved catalog when available; endpoint discovery remains usable. If the endpoint fails or returns an empty list, catalog entries cannot establish availability and matching cached models or the handwritten-model fallback apply. Availability means the endpoint advertises a model; discovery does not issue billable completion probes.

All three URL/source fields (`modelsUrl`, `metadataUrl`, `metadataProvider`) have rows in `/config:model-discovery` and changes apply immediately. The startup cache stores enriched results; changing metadata URL or provider invalidates it. Startup refresh is enabled by default. Set `refreshOnStartup: false` for cache-only startup; a cache miss still triggers discovery. Offline registry reads never perform network requests, and explicit online refresh reloads both sources. Providers share catalog requests during startup and `/config:model-discovery-refresh`. Concurrent `/model` refresh hooks also share one lookup and metadata-file update per catalog URL, including while slower gateway requests are pending. Each new refresh fetches fresh metadata; provider-specific matching remains isolated. See [config.example.json](./config.example.json) for a complete example to merge into `models.json`.

## Refreshing the cache

```
/config:model-discovery-refresh
```

Forces a rediscovery of every discovery provider and updates the model cache and metadata JSON, notifying the result for each provider.

## Saved metadata and model selection

The plugin manages two files under the Pi agent directory (respects `PI_CODING_AGENT_DIR`):

- `extensions/pi-models-discovery/metadata.json`: normalized catalogs keyed by source URL, with a `fetchedAt` timestamp. Updated on startup and online refresh; failed catalog requests can use the last successful catalog for that URL. Gateway credentials and headers are excluded.
- `extensions/pi-models-discovery/cache.json`: endpoint-listed models with merged metadata, used for offline registration and gateway failures. Only a cache matching the gateway configuration is reused.

`models.json` remains the gateway configuration. Automatic discovery never rewrites it; the settings panel writes it only when you change provider settings. Clear `metadataUrl` to disable catalog lookup. `refreshOnStartup` defaults to `true` and has a boolean row in `/config:model-discovery`.

Use Pi's `/model` command to select any registered gateway model. Embedding and other explicitly non-conversational entries are excluded. A model with `capabilities.chat: false` and `capabilities.responses: true` uses `openai-responses` when the provider otherwise uses `openai-completions`. Explicit per-model `api` declarations also take precedence over the provider protocol. Unknown capabilities use the configured protocol; canonical metadata never changes gateway routing.

## Test gateway models

```text
/model_test                         # Current selected model
/model_test my-gateway/model-id     # One model; model-id may contain slashes
/model_test my-gateway/*            # Every registered model for this provider
/model_test all                     # Models from discoverModels providers only
```

A unique bare model ID or a provider ID is also accepted. Ambiguous model IDs require `provider/model-id`. Command argument completion lists registered models and provider groups.

Each test sends an isolated “Reply with only OK” prompt using `pi-model-request`, so Pi's resolved authentication, gateway URL, headers, and provider session attribution apply. It uses at most 64 output tokens, a 30-second deadline, no retries, and no tools or conversation history. Tests run sequentially and report pass/fail, protocol, elapsed time and the failure reason, followed by a summary. A nonempty text reply confirms the model responded; empty text, API/auth errors, and timeouts fail. The current model selection and conversation are preserved.

Tests make real requests and may incur gateway charges. Discovery itself only requests model lists and catalogs. A pass confirms a small text request worked at that time; it does not verify vision, tools, thinking tiers, or advertised context limits. Reasoning-only responses that exhaust the small output budget fail to confirm availability; inspect the reported result before treating the model as unavailable.

## Behavior

- **Startup**: register matching cached models, then refresh the endpoint list and configured metadata catalog. Set provider `refreshOnStartup: false` to skip the startup network refresh when cached models exist. The model cache lives at `~/.pi/agent/extensions/pi-models-discovery/cache.json`. The cache is invalidated automatically when the provider configuration fingerprint (baseUrl+api+apiKey+headers+compat+modelsUrl+modelIdRegex+modelApi+metadataUrl+metadataProvider) changes, triggering a fresh network discovery.
- **Online refresh**: `/config:model-discovery-refresh`, or the `refreshModels` hook triggered when opening `/model`, rediscovers online and updates the cache. If gateway discovery fails, the hook rejects so Pi reports the refresh failure while retaining the previous model list. Other providers can still refresh successfully.
- **Offline / fetch failure**: matching cached models are retained, or handwritten `models` in models.json (if any) are kept as a fallback, and an explicit warning is surfaced via in-session notify — never a silent degradation. One provider failing does not affect the others.
- **apiKey resolution** (discovery request only): supports literals and `$ENV_VAR` / `${ENV_VAR}` interpolation; `!command` values skip discovery with an explicit warning (chat requests are still resolved by pi itself and are unaffected).
- When both endpoint and configured catalog metadata are absent, discovered models default to `reasoning: true`, `input: ["text", "image"]`, zero cost, `contextWindow` 1M, `maxTokens` 64K, and `compat.supportsDeveloperRole: false`. Advertised metadata replaces these defaults as described below. Provider-level `compat` is merged into every discovered model.
- Discovered models default `thinkingLevelMap.xhigh` / `max` to `null`; extra tiers are no longer assumed to work on every backend. Standard tiers keep Pi's default mapping. Endpoint thinking metadata and matching catalog `reasoning_options` can enable or hide tiers per model (see [Thinking levels](#thinking-levels)). Opt in with provider-level `compat.thinkingLevelMap` when the service supports extra tiers, or set any unsupported tier to `null`.
- For non-reasoning models, set provider-level `compat.reasoning: false` so `/thinking` offers only `off`. `reasoning` and `thinkingLevelMap` are extracted to the model's top level; other `compat` fields (such as `supportsReasoningEffort` and `thinkingFormat`) are forwarded normally. Mixed-model gateways can use `modelOverrides` by model.id. Existing caches apply the current thinking configuration at startup without a network refresh.

Example for a local non-reasoning service. To enable verified extra tiers instead, use `"thinkingLevelMap": { "xhigh": "xhigh", "max": "max" }` and remove `"reasoning": false`.

```json
{
  "providers": {
    "local": {
      "baseUrl": "http://127.0.0.1:8000/v1",
      "api": "openai-completions",
      "discoverModels": true,
      "compat": {
        "reasoning": false,
        "supportsReasoningEffort": false,
        "thinkingLevelMap": { "xhigh": null, "max": null }
      }
    }
  }
}
```

The old `/model-discovery`, `/model-discovery-refresh`, `/pi-model-discovery`, and `/pi-model-discovery-refresh` names remain available as compatibility aliases.

## Model metadata

Discovery reads each model's metadata using the following precedence (first valid value wins):

| Pi field | Model-list fields, in precedence order |
| --- | --- |
| `name` | `name`, `display_name`, then the model ID |
| `contextWindow` | `context_window`, `contextWindow`, `max_model_len` (vLLM), `context_length`, `max_context_length`, `max_input_tokens` (Anthropic), `limit.context` (models.dev) |
| `maxTokens` | `max_tokens`, `maxTokens`, `max_output_tokens`, `max_completion_tokens`, `limit.output` (models.dev) |
| `input` | Always includes `text`. `image` is added when an explicit `input` array containing `text` and/or `image` lists it; otherwise when `capabilities.vision` or `capabilities.image_input` is supported; then `modalities.input` (models.dev) |
| `reasoning` | Provider `compat.reasoning`, model `reasoning`, `capabilities.reasoning`, `capabilities.thinking` |

Capability values may be booleans or objects such as `{ "supported": false }`. Explicit `false` is preserved: no image support produces `input: ["text"]`, and no reasoning support produces `reasoning: false`. Cached startup and online refresh retain this metadata. Unknown capabilities keep the existing defaults; extra thinking tiers are enabled only by advertised thinking metadata.

Token limits must be positive safe integers. Invalid limits fall through to the next alias or the existing defaults. Names must be nonempty strings; unsupported entries in `input` are ignored.

Costs use **prices per one million tokens**, matching Pi's `cost` fields:

| Pi cost field | Model-list fields, in precedence order |
| --- | --- |
| `input` | `cost.input`, `pricing.input_per_million` |
| `output` | `cost.output`, `pricing.output_per_million` |
| `cacheRead` | `cost.cacheRead`, `cost.cache_read`, `pricing.cache_read_input_per_million` |
| `cacheWrite` | `cost.cacheWrite`, `cost.cache_write`, `pricing.cache_creation_input_per_million` |

Only finite, nonnegative numbers are accepted; zero is a valid price. Missing or invalid prices default to zero. Prices in other units, long-context tiers, and modality-specific prices are not mapped to these four fields. Use `modelOverrides` for model-specific adjustments.

Startup refresh replaces older cached defaults with advertised metadata. Use `/config:model-discovery-refresh` to refresh immediately, including when startup refresh is disabled.

### Thinking levels

A model entry can advertise its thinking controls in three ways. The plugin saves these declarations in both metadata and model caches and rebuilds the final map at startup.

**Explicit map.** `thinkingLevelMap`, then `thinking_level_map`, uses Pi's format. The first alias with at least one valid entry is used as a whole; aliases are not merged. Keys must be `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Values must be nonempty strings (the value sent to the backend) or `null` (hidden). Other entries are ignored.

**models.dev controls.** `reasoning_options` lists adjustable controls, for example:

```json
{
  "reasoning_options": [
    { "type": "effort", "values": ["low", "medium", "high", "xhigh", "max"] },
    { "type": "toggle" }
  ]
}
```

`effort.values` is a complete list: known effort levels absent from it are hidden. `none` maps to Pi's `off` on OpenAI effort APIs. A `toggle` or `budget_tokens` control keeps `off` available; an effort-only model without `none` hides it. Malformed controls and unknown effort values are ignored. Budget options retain validated `min`/`max` limits in metadata; manual thinking uses Pi's existing budget levels and budget calculation.

On `anthropic-messages`, an effort option selects adaptive thinking when there is no budget option, or when the list includes `max` or `xhigh` (which require adaptive thinking). An effort-plus-budget model with only `low`/`medium`/`high`, such as Opus 4.5, stays in manual budget mode. Explicit provider `compat.forceAdaptiveThinking: true` or `false` overrides this inference. In adaptive mode, Pi's `minimal` is an alias for native `low`. `toggle` does not describe per-effort restrictions or Sonnet's `between_tools` mode; those still require explicit configuration or gateway verification.

Endpoint controls take precedence; matching catalog controls fill missing `reasoning_options`. Catalog `thinkingLevelMap` and `capabilities.effort` do not replace endpoint declarations.

**Effort capabilities.** `capabilities.effort` lists backend effort values as booleans or `{ "supported": boolean }` objects, as in Anthropic's model list:

```json
{ "effort": { "supported": true, "low": { "supported": false }, "medium": { "supported": true },
  "high": { "supported": false }, "max": { "supported": false } } }
```

It is used only where Pi actually sends that effort value:

| `api` | Condition | Pi level → backend effort |
| --- | --- | --- |
| `anthropic-messages` | Inferred from `reasoning_options`, or provider `compat.forceAdaptiveThinking: true` (`output_config.effort`) | `minimal` and `low` → `low`; other levels keep their names |
| `openai-responses` | Always (`reasoning.effort`) | Same name |
| `openai-completions` | `compat.thinkingFormat` absent or `"openai"`, and `compat.supportsReasoningEffort` is not `false` (`reasoning_effort`) | Same name |

If a level's backend value is explicitly supported, the level uses that value. If it is explicitly unsupported, the level is `null`. If it is not listed, the default applies: standard levels stay available and `xhigh` / `max` stay hidden. A level is never remapped to a different backend value. `effort.supported: false` disables catalog effort controls. Malformed entries, other APIs, and Anthropic budget thinking (without adaptive mode, where Pi sends no effort) keep the defaults. With the example above, an adaptive Anthropic model offers only `off` and `medium`. The OpenAI rows assume Pi sends `reasoning_effort`; Pi's URL detection turns it off for some hosts (for example xAI or Z.ai), so set `compat` explicitly there.

Each key is resolved separately, from lowest to highest precedence:

1. Defaults: `xhigh` and `max` are `null`.
2. Endpoint `reasoning_options`, or matching catalog controls when absent.
3. Levels derived from endpoint `capabilities.effort`.
4. The endpoint model's explicit map.
5. Provider `compat.thinkingLevelMap`, including explicit `null`.
6. `modelOverrides[modelId].thinkingLevelMap` in models.json, applied by Pi.

Provider `compat.reasoning: false` still limits every model to `off`.

The cache stores advertised thinking metadata per model and revalidates it at startup. The final map is rebuilt from that metadata and the current provider configuration, so cached startup, offline reads, and online refresh agree. Caches written by older versions have no advertised metadata and keep the defaults, even if they stored extra tiers, until the next online refresh. Reasoning controls from older metadata caches become available after the next successful catalog refresh. The metadata is the endpoint's or catalog provider's claim; confirm a tier with a real request before relying on it.

## Uninstall

```bash
pi remove pi-models-discovery
```

After removal, providers fall back to the static configuration in models.json (handwritten `models`, or none).
