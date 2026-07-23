# AGENTS.md — omp-provider-kiro

> Context for coding agents working on this repository.

## Project overview

OMP provider extension for Kiro's management and streaming APIs. It uses OMP-native dynamic model discovery, supports API-key and OAuth/Kiro CLI authentication, converts live Kiro request schemas into canonical OMP thinking metadata, and bundles as a self-contained ESM extension.

Minimum supported OMP version: **17.0.9**.

## Source map

| File | Responsibility |
|---|---|
| `src/index.ts` | Provider registration (`fetchDynamicModels`, OAuth, custom stream) |
| `src/management.ts` | Profile-aware Kiro management routing and `ListAvailableModels` retrieval |
| `src/model-discovery-fixture.ts` | Fail-closed model-response/schema sanitizer and fixture safety checks |
| `src/model-discovery.ts` | Sanitized Kiro metadata → OMP `ProviderModelConfig` mapping |
| `src/models.ts` | API endpoint/region helpers and explicit legacy selector aliases only |
| `src/adaptive-thinking.ts` | Canonical OMP thinking metadata → Anthropic/GPT Kiro request fields |
| `src/oauth.ts` | Builder ID, IAM Identity Center, and social OAuth login/refresh |
| `src/kiro-cli.ts` | Local Kiro CLI SQLite credential reuse |
| `src/stream.ts` | Request construction, routing, retries, and event streaming |
| `src/transform.ts` | OMP messages/tools/images → Kiro request structures |
| `src/retry.ts` | Provider-wide timeout, backoff, and error classification |
| `test/fixtures/kiro-list-available-models-2.13.1.json` | Sanitized first-party discovery fixture |

## Dynamic discovery contract

`src/index.ts` registers `fetchDynamicModels`; do not add a static `models` array. OMP owns:

- A 15-second extension discovery timeout
- A 24-hour SQLite model cache
- Startup background refresh
- Provider refresh from `/model`
- Retention of cached models when refresh fails

The extension must return one authoritative, fully validated catalog or throw. Never return a partial catalog after encountering malformed model/schema data.

### Model IDs

Preserve `ListAvailableModels.modelId` exactly. Never perform generic digit-dot/digit-dash rewriting: `gpt-5.6-sol` is a valid exact Kiro ID. `src/models.ts` contains a small explicit alias map only for selectors emitted by older extension versions.

### Adding model support

Do **not** add model IDs to source code. Capture a new sanitized fixture when Kiro changes its catalog, then update schema-family parsing only if Kiro introduces a genuinely new request schema.

```powershell
bun run probe:models
```

The probe and sanitizer must remain identity-free: no headers, tokens, profile/account identifiers, email addresses, ARNs, or machine paths may be serialized.

## Reasoning metadata

Request behavior must derive from `model.thinking`, because OMP persists that canonical metadata in its SQLite model cache. Do not dispatch on model IDs.

Supported Kiro schema families:

- Anthropic adaptive: `thinking`, `output_config.effort`, and `max_tokens`
- GPT reasoning: `reasoning.mode` and `reasoning.effort`

Schema-less models use `reasoning: false` and no `thinking` metadata. This means there is no configurable reasoning surface; it does not claim the model cannot reason internally.

### Sonnet 5 output semantics

The live 2.13.1 fixture reports:

- Generic `tokenLimits.maxOutputTokens = 64000`
- Adaptive request-schema `max_tokens.maximum = 128000`

The mapper uses 128K as the combined adaptive request ceiling. Anthropic defines this as internal thinking plus visible text/tool output, not a separate thinking budget and not a guarantee of 128K visible text.

### Effort mapping

- Claude tiers/defaults come from the live schema.
- OMP `minimal` maps to Claude's lowest advertised tier.
- Unsupported intermediate Claude tiers clamp upward (`xhigh` → `max` on a four-tier model).
- GPT `none` is represented in OMP as `minimal` via `effortMap`.
- GPT mode defaults to `standard`; `pro` is not exposed because OMP has no second mode selector.

## Authentication and routing

Credential precedence for discovery and streaming:

1. Explicit OMP bearer
2. Exact `KIRO_API_KEY` environment match
3. Valid Kiro CLI social/IDC bearer when OMP supplies no bearer

API keys default to `us-east-1`, accept `KIRO_API_REGION`, and use no profile ARN. OAuth discovery resolves `ListAvailableProfiles` in memory, derives the management region from the profile ARN, and sends `{ origin: "KIRO_CLI", profileArn }` to `ListAvailableModels`.

Never use unrelated local CLI routing metadata for an explicit bearer; access tokens must match exactly.

## Streaming invariants

- Kiro history does not require synthetic user/assistant alternation.
- Tool results are represented in Kiro user-side context.
- Tool-use IDs must match `^[a-zA-Z0-9_-]+$`; normalization is serialization-only and preserves pairing.
- `envState.operatingSystem` must be `windows`, `macos`, or `linux`, not Node's raw `win32`.
- 413/context-length errors are surfaced immediately for OMP compaction handling.
- Provider-local retries are limited to auth refresh, capacity errors, first-token/idle timeout, and known empty-response quirks.
- First-token timeout is a provider-wide policy because discovery supplies no per-model timeout metadata.
- Provider-reported usage metrics override input/output estimates field-by-field; cache tokens are never estimated.
- `duration` covers the complete provider call, while `ttft` starts at invocation and ends at the first non-empty model output—not metadata or framing bytes.

## Development

```powershell
bun install
bun run check
bun run test
bun run build
```

Use focused Vitest files during development and the full suite once before completion. Rebuild `dist/index.js` after runtime changes; CI checks for a stale bundle.

Tests mock network and process integrations with Vitest. Live discovery probes are intentional, separate operations and must not run as part of the normal test suite.

## Agent skills

### Issue tracker

Issues and PRDs are tracked as GitHub issues in `ajdiyassin/omp-extension-kiro` via the `gh` CLI. External PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repository root. See `docs/agents/domain.md`.
