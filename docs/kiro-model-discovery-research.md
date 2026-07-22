# Kiro CLI 2.13.1 model-discovery research

Date: 2026-07-22

## Result

A direct `AmazonCodeWhispererService.ListAvailableModels` probe succeeded using the extension's Kiro CLI OAuth credential path. The response was sanitized in memory and written to:

`test/fixtures/kiro-list-available-models-2.13.1.json`

The fixture contains 18 models and no authorization headers, bearer/refresh tokens, profile identifiers, account identifiers, email addresses, ARNs, or machine paths. A defense-in-depth forbidden-value scan returned no matches.

This fixture is sufficient to replace most hand-maintained model metadata with endpoint-derived values. It is not sufficient to derive first-token timeout policy, tool support, or a general reasoning flag for schema-less models.

## Probe design

Implementation:

- `scripts/probe-list-models.ts`
- `src/model-discovery-fixture.ts`
- `test/model-discovery-fixture.test.ts`
- npm command: `npm run probe:models`

The probe never serializes or logs request headers, request bodies, raw response bodies, profile data, or credentials. It reconstructs an allowlisted response projection in memory and writes only after full validation.

Safety properties:

1. Exact top-level and per-model key allowlists.
2. Bounded model counts, strings, schema depth, arrays, and response size.
3. Known input modalities only (`TEXT`, `IMAGE`).
4. Positive safe-integer token limits.
5. Recursive JSON Schema reconstruction from known schema keywords.
6. Duplicate-ID and missing-default rejection.
7. Identity/credential/path scan before atomic publication.
8. A 10-second fetch abort, below OMP's 15-second dynamic-provider timeout.
9. HTTP failures report status only; response bodies and request IDs are not logged.

The successful Kiro request body required both `origin: "KIRO_CLI"` and the active `profileArn`. The probe obtains the profile in memory through `ListAvailableProfiles`, derives the Kiro API region from its ARN, and discards the profile response after routing. This matters because the IAM Identity Center credential region and selected Kiro profile region need not be the same.

## Authentication findings

### API key

`KIRO_API_KEY` remains the highest-precedence source (`src/kiro-cli.ts`). It is sent as the bearer, defaults to `us-east-1`, and does not require a profile ARN.

### OAuth / Kiro CLI

The probe follows the extension's documented non-interactive cascade:

1. `KIRO_API_KEY`
2. valid Kiro CLI social token
3. valid Kiro CLI IDC token

The probe intentionally does **not** refresh an expired shared OAuth credential. Kiro CLI PKCE refresh is owned by Kiro CLI, and OMP's future `fetchDynamicModels(apiKey)` callback should normally receive OMP's already-resolved bearer. Independently refreshing a shared token inside model discovery risks refresh-token races.

The callback's bearer alone does not contain region/profile routing metadata. Native discovery therefore also needs provider-local routing resolution:

- API key: configured/default API region, no profile;
- OAuth: resolve the active profile in memory and route by profile ARN region;
- never log or persist the profile ARN in the model fixture.

Primary code sources: `src/index.ts`, `src/kiro-cli.ts`, `src/stream.ts`, and OMP 17.0.7 `packages/coding-agent/src/config/model-registry.ts`.

## Live 2.13.1 inventory

The response contains 18 models and `auto` as the default. It includes models absent from the extension's current static catalog:

- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`
- `claude-opus-4.5`

The dotted GPT IDs prove generic digit-dot-digit rewriting is unsafe. Dynamic discovery should preserve server `modelId` values exactly and maintain explicit aliases only for legacy OMP selectors.

## Metadata supplied by ListAvailableModels

### Supplied directly

| Requirement | Response source | Finding |
|---|---|---|
| Model ID | `modelId` | Exact API identifier; preserve it. |
| Display name | `modelName` | Present, currently equal to ID. |
| Description | `description` | Present; OMP provider model config currently has no description field. |
| Input modalities | `supportedInputTypes` | Authoritative `TEXT` / `IMAGE` list per model. |
| Context limit | `tokenLimits.maxInputTokens` | Present for every model. |
| Output limit | `tokenLimits.maxOutputTokens` | Present for every model. |
| Default model | `defaultModel.modelId` | `auto`. OMP has no extension-level provider-default field. |
| Prompt caching | `promptCaching` | Support flag and checkpoint limits are present. |
| Billing multiplier | `rateMultiplier`, `rateUnit` | Credits per request; not token pricing. |
| Configurable reasoning schema | `additionalModelRequestFieldsSchema` | Present for adaptive Claude and GPT 5.6 models. |

### Anthropic adaptive-thinking metadata

The endpoint fully describes the Anthropic request schema for:

- `claude-sonnet-5`
- `claude-opus-4.8`
- `claude-opus-4.7`
- `claude-opus-4.6`
- `claude-sonnet-4.6`

It supplies:

- `thinking.type`: `adaptive | disabled`
- `thinking.display`: `summarized | omitted`
- ordered effort enum and default
- `max_tokens` minimum and maximum

Observed effort ladders:

- Sonnet 5, Opus 4.8, Opus 4.7: `low, medium, high, xhigh, max`
- Opus 4.6, Sonnet 4.6: `low, medium, high, max`

Observed defaults:

- Opus 4.7: `xhigh`
- the other adaptive Claude entries: `high`

### GPT 5.6 reasoning metadata

Each GPT 5.6 model exposes a different schema:

```json
{
  "reasoning": {
    "mode": "standard | pro",
    "effort": "none | low | medium | high | xhigh | max"
  }
}
```

Both fields default to `standard` / `high`. This cannot be sent through the existing Anthropic-only adaptive payload builder. Dynamic discovery must recognize at least two request-schema families rather than treating every `additionalModelRequestFieldsSchema` as Anthropic adaptive thinking.

### Limits that correct current hardcoding

The fixture reports:

- GPT 5.6 variants: 272K input, 128K output.
- Opus 4.8 / 4.7: 1M input, 128K output.
- Opus 4.6 / Sonnet 4.6: 1M input, 64K output.
- Sonnet 5: 1M input, 64K output, while its adaptive `max_tokens` schema allows up to 128K.
- All schema-less listed models: 64K output in this profile, not the extension's current 8K fallback for several non-Claude models.

The Sonnet 5 distinction shows that `tokenLimits.maxOutputTokens` and adaptive `max_tokens.maximum` are separate fields and must not be blindly collapsed without deciding their runtime semantics.

## Metadata not supplied

### First-token timeout

No timeout field is returned. Keep timeout policy in the streaming/retry layer. Use a conservative default for unknown models and explicit evidence-based overrides where needed.

### Tool support

No tool-capability field is returned. Do not infer a `supportsTools` value from this fixture.

### General reasoning flag for schema-less models

Schema presence proves configurable reasoning fields, but schema absence does not prove a model cannot reason internally. OMP's boolean `reasoning` field needs a documented policy or a small compatibility overlay until OMP can represent this distinction more accurately.

### Provider default integration

Kiro supplies `defaultModel: auto`, but OMP's extension provider registration has no provider-default field. Expose `auto`; do not silently replace the user's configured OMP default.

## OMP 17.0.7 integration implications

OMP's `fetchDynamicModels` is the correct registration seam. Source: `C:/Users/Yassin/Dev/oh-my-pi-fork/packages/coding-agent/src/extensibility/extensions/types.ts` and `.../config/model-registry.ts`.

Relevant behavior:

- mutually exclusive with static `models`;
- 15-second outer timeout;
- 24-hour SQLite cache for runtime extension providers;
- authoritative successful dynamic results;
- startup background discovery;
- provider refresh from `/model`;
- callback receives a bearer string, not the full OAuth credential object.

Recommended migration:

1. Parse and validate the same sanitized response shape at runtime.
2. Preserve exact Kiro IDs and add explicit legacy aliases separately.
3. Map modalities and token limits directly.
4. Parse Anthropic and GPT reasoning schema families separately.
5. Keep first-token timeout outside discovery.
6. Throw on malformed/partial responses so OMP can retain cached data; never return a partial authoritative catalog.
7. Remove the extension's separate home-directory model cache after OMP-native discovery is proven.

## Verification evidence

- Installed CLI: Kiro CLI 2.13.1.
- Live sanitized capture: 18 models, OAuth IDC, `us-east-1` profile route.
- Sanitizer tests: 9 passing focused tests.
- Type check: `npm run check` passed before live capture.
- Fixture secret scan: no matches for ARN, bearer, authorization, token, profile, account, email, or machine-path patterns.
