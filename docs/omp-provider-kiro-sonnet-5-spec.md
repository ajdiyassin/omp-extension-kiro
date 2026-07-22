# Spec: Add Claude Sonnet 5 to `omp-provider-kiro`

> **Historical specification:** model-ID lists and static catalog instructions here are superseded by OMP-native `ListAvailableModels` discovery. See `README.md`, `AGENTS.md`, and `docs/kiro-model-discovery-research.md` for the current architecture.


Status: DRAFT — research complete, not implemented.
Author: research task, 2026-07-08.
Scope: add the `claude-sonnet-5` model to the Kiro provider extension, wired for
adaptive thinking, correct region availability, and the Sonnet 5 behavior changes.

---

## Goal

Expose Claude Sonnet 5 as a first-class `kiro/claude-sonnet-5` model in the
extension, with:

- Model discovery in both static catalog and region-filtered catalog.
- Adaptive thinking enabled and effort-mapped (thinking chain visible), matching
  the M1 native-reasoning path already shipped.
- Correct availability in the regions Kiro actually serves it (`us-east-1` and
  `eu-central-1`).
- No regressions from the three Sonnet 5 behavior changes (adaptive-on-by-default,
  sampling-params-rejected, manual-extended-thinking-removed).

Acceptance: `omp --list-models` shows `kiro/claude-sonnet-5`; a smoke prompt at a
reasoning effort streams a thinking block then an answer; `npm test` green with
updated counts; typecheck clean.

---

## Background — verified research findings

### Model facts (Anthropic + AWS Bedrock + Kiro blog, cross-checked)

| Property | Value | Source |
|---|---|---|
| API model ID (Anthropic) | `claude-sonnet-5` | Anthropic what's-new |
| Kiro model ID | `claude-sonnet-5` | Kiro blog; ref PRs #87/#111 |
| Bedrock model ID | `anthropic.claude-sonnet-5` | AWS model card |
| Context window | 1,000,000 (default AND max; no smaller variant) | Anthropic; AWS |
| Max output tokens | 128,000 (128K) | Anthropic; AWS model card |
| Reasoning | adaptive thinking, **on by default** | Anthropic; AWS |
| Effort tiers | 5-tier — supports `xhigh` (and `max`) | Adaptive-thinking doc |
| Input modalities | text + image | AWS model card |
| Launch date | 2026-06-30 | AWS model card |
| Knowledge cutoff | 2026-01 | AWS model card |

### Region availability

Kiro blog (2026-07-01) states Sonnet 5 is rolling out to **AWS US-East-1 (N.
Virginia) and AWS Europe (Frankfurt = `eu-central-1`)** with cross-region
inference, full 1M context, 1.3x credit multiplier (same as Sonnet 4.6).

This is stronger than the two reference PRs: #87 added it to both `us-east-1` and
`eu-central-1`; #111 added `us-east-1` only (they lacked EU verification). The
Kiro blog explicitly names Frankfurt, so **add to both** — but region availability
is the one item that warrants a live confirmation (see Verification).

### The three Sonnet 5 behavior changes vs. the extension

1. **Adaptive thinking on by default.** On Sonnet 4.6, no `thinking` field ⇒ no
   thinking. On Sonnet 5, the same request thinks. AWS wording is stronger:
   "adaptive thinking is always on and cannot be disabled; effort level is
   configurable." The extension always sends an adaptive payload for adaptive
   models (thinking enabled by default, `KIRO_ADAPTIVE_THINKING=0` kill-switch),
   so this aligns — no `thinking:{type:"disabled"}` path is needed. Effort still
   controls depth.

2. **Sampling parameters rejected (400 on non-default `temperature`/`top_p`/`top_k`).**
   Verified the extension sends **none** of these — `grep` for
   `temperature|top_p|top_k|topP|topK|samplingParams` finds only `maxTokens`
   usages, no sampling params in any request path. No change needed; call it out
   as a non-regression to preserve.

3. **Manual extended thinking removed (400 on `thinking:{type:"enabled",budget_tokens}`).**
   The extension only ever emits `thinking:{type:"adaptive",display:"summarized"}`
   (see `buildKiroAdaptiveThinkingPayload`). No `budget_tokens` anywhere. Safe.

### New tokenizer (~1.0–1.35x tokens for same text)

Not an API/wire change — request/response/stream shapes are identical. Impact is
only on **measurement**:
- The extension estimates output tokens as `content.length / 4` and back-calculates
  input tokens from `contextUsagePercentage`. Both are already approximations, so
  the tokenizer change does not break anything; estimates just drift slightly.
- No code change required. Optionally note in a comment that Sonnet 5 counts run
  higher.

### Refusal stop reason (`stop_reason: "refusal"`, HTTP 200)

Sonnet 5 adds real-time cybersecurity safeguards that return a refusal as a
**successful 200** with `stop_reason: "refusal"`, not an error. The parser passes
`stopReason` through untouched (`event-parser.ts:48-53`); `stream.ts` maps
`END_TURN → stop` and preserves other values. A `refusal` stop reason will
therefore flow through as a normal stop with whatever text the model returned.
This is acceptable for MVP (no crash, no misclassification as an error). Handling
it specially (surfacing "refused") is an OPTIONAL enhancement, not required.

### Wire protocol

Identical to existing Kiro Claude models: same `runtime.{region}.kiro.dev/`
endpoint, same AWS event-stream framing, same `reasoningContentEvent` /
`assistantResponseEvent` / `contextUsageEvent` frames. No parser, transform, or
stream changes are needed for Sonnet 5 beyond catalog + adaptive wiring.

---

## The critical gotcha: TWO sources of truth

Adding a Kiro model correctly requires editing **both** files. The reference PRs
(#87, #111) edited only the first and would have shipped Sonnet 5 with **no
thinking and no effort control**:

1. `src/models.ts` — catalog, region allowlists, OMP-facing `thinking` block.
   Governs discovery, `/list-models`, region filtering, and the effort tiers OMP
   shows in the UI.
2. `src/adaptive-thinking.ts` — `KIRO_ADAPTIVE_MODELS` map. Governs whether an
   adaptive payload is built at request time. `buildKiroAdaptiveThinkingPayload`
   returns `undefined` for any model **not** in this map ⇒ no `thinking`, no
   `output_config.effort`, no `max_tokens` sent. `isAdaptiveThinkingSupported`
   and `mapOmpEffortToKiroEffort` are also keyed off it.

Both must list `claude-sonnet-5`, with **matching** effort maps and max-tokens, or
behavior silently diverges from what the catalog advertises.

---

## Non-goals

- No wire-protocol changes (parser/transform/stream logic untouched).
- No special `refusal` stop-reason UI (optional follow-up).
- No tokenizer re-estimation logic.
- No `thinking:{type:"disabled"}` support (extension has no thinking-off path;
  effort `minimal`/`low` already minimizes).
- No Bedrock direct path — this is the Kiro runtime provider only.
- No pricing changes (Kiro subscription ⇒ `ZERO_COST`).

---

## Design — file-by-file changes

### 1. `src/models.ts`

**1a. `KIRO_MODEL_IDS` set** — add the Kiro-format ID. Sonnet 5 has no
digit-dash-digit version, so `resolveKiroModel`'s `(\d)-(\d)→$1.$2` regex leaves
`claude-sonnet-5` unchanged (verified). Add the literal string:

```ts
export const KIRO_MODEL_IDS = new Set([
  "claude-opus-4.8",
  ...
  "claude-sonnet-5",   // NEW — no dot conversion needed
  "claude-sonnet-4.6",
  ...
]);
```

**1b. `MODELS_BY_REGION`** — add the dash-format ID (region sets use dash IDs, e.g.
`claude-sonnet-4-6`) to **both** regions:

```ts
"us-east-1": new Set([ ..., "claude-sonnet-5", ... ]),
"eu-central-1": new Set([ ..., "claude-sonnet-5", ... ]),
```

**1c. `kiroModels` array** — add the model definition. Place it above Sonnet 4.6
(Sonnet 5 is the flagship Sonnet). Mirror the Opus 4.8 5-tier `thinking` block
since Sonnet 5 supports `xhigh`:

```ts
{
  id: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  api: "kiro-api" as const,
  provider: "kiro" as const,
  baseUrl: BASE_URL,
  reasoning: true,
  thinking: {
    mode: "anthropic-adaptive" as const,
    efforts: ["minimal", "low", "medium", "high", "xhigh"] as const,
    defaultLevel: "medium" as const,   // see Effort mapping decision
    effortMap: { minimal: "low", low: "medium", medium: "high", high: "xhigh", xhigh: "max" }, // FIVE_TIER
    supportsDisplay: true,
  },
  input: ["text", "image"] as ("text" | "image")[],
  cost: ZERO_COST,
  contextWindow: 1000000,
  maxTokens: 128000,   // official 128K; see Open question O2
  firstTokenTimeout: 180_000,   // match Opus flagships (deep thinking = slow first token)
},
```

### 2. `src/adaptive-thinking.ts`

Add to `KIRO_ADAPTIVE_MODELS` with `FIVE_TIER` (Sonnet 5 supports `xhigh`, unlike
Sonnet 4.6 which uses `FOUR_TIER`):

```ts
const KIRO_ADAPTIVE_MODELS: Record<string, ModelConfig> = {
  "claude-opus-4-8": { kiroModelId: "claude-opus-4.8", maxTokens: 128000, defaultOmpEffort: "medium", effortMap: FIVE_TIER },
  ...
  "claude-sonnet-5": { kiroModelId: "claude-sonnet-5", maxTokens: 128000, defaultOmpEffort: "medium", effortMap: FIVE_TIER }, // NEW
  "claude-sonnet-4-6": { ... },
};
```

`kiroModelId` here is `claude-sonnet-5` (no dot). `maxTokens` MUST equal the
catalog `maxTokens` (128000). `effortMap` MUST equal the catalog `thinking.effortMap`.

### 3. Tests

- `test/models.test.ts`:
  - `KIRO_MODEL_IDS.size` `13 → 14`.
  - `kiroModels` length `13 → 14`.
  - eu-central-1 filter test: assert it now **includes** `claude-sonnet-5`.
- `test/registration.test.ts`: `config.models` length `13 → 14`.
- New assertions (recommended):
  - Sonnet 5 has `reasoning: true` and a `thinking.mode === "anthropic-adaptive"`.
  - `isAdaptiveThinkingSupported("claude-sonnet-5") === true`.
  - `mapOmpEffortToKiroEffort("claude-sonnet-5", "high") === "xhigh"` and
    `("claude-sonnet-5", "xhigh") === "max"` (FIVE_TIER proof).
  - `buildKiroAdaptiveThinkingPayload("claude-sonnet-5", "medium")` returns
    `{ thinking:{type:"adaptive",display:"summarized"}, output_config:{effort:"high"}, max_tokens:128000 }`.
  - `resolveKiroModel("claude-sonnet-5") === "claude-sonnet-5"` (no dot mangling).

Search for any hard-coded model-count assertions beyond the four above before
finalizing (e.g. snapshot tests).

### 4. Docs (optional, low priority)

`AGENTS.md` "Adding a New Model" already documents the two-file requirement
implicitly; consider adding an explicit note that `adaptive-thinking.ts` must be
updated for any reasoning model. Not required for the feature to work.

---

## Effort mapping decision (needs your call — O1)

Sonnet 5 is 5-tier. `defaultOmpEffort` sets what happens when the user gives no
explicit effort. Options:

- **`medium` (recommended)** → Kiro `high` under FIVE_TIER. Matches Anthropic's
  native default effort (`high`) and mirrors Opus 4.8's config. Balanced latency.
- `high` → Kiro `xhigh`. Always-deep thinking; higher latency/credit burn by
  default. Matches Opus 4.7.

Recommendation: `medium`, consistent with Opus 4.8 and Anthropic's default. The
default is a one-line change if you prefer otherwise.

---

## Verification plan

1. `npm run check` — typecheck clean.
2. `npm test` — all green with updated counts.
3. `npm run build` — bundle rebuilds; reload OMP (symlinked plugin).
4. Live smoke (the only step that needs network + a Kiro sub with Sonnet 5 access):
   - `kiro/claude-sonnet-5` at effort `high` (⇒ Kiro `xhigh`): expect a streamed
     thinking block (M1 path) followed by an answer.
   - Confirm the request reaches `runtime.{region}.kiro.dev` and returns 200.
   - Confirm effort at `minimal`/`low` still returns a valid answer (adaptive may
     skip thinking — expected).
5. Region check: run once with an `eu-central-1` credential to confirm Sonnet 5 is
   actually served there (blog says yes; this is the one unverified external claim).

### Do we need network captures? — mostly NO

The wire protocol is byte-identical to existing Kiro Claude models, and the model
ID string is already confirmed (`claude-sonnet-5`) by two independent PRs. A full
mitmproxy capture is **not required**. A capture is only worth doing to answer two
narrow questions if the live smoke test surfaces a 400:

- **O2 — does Kiro accept `max_tokens: 128000` for `claude-sonnet-5`?** The
  reference PRs conservatively set 64K. Official specs say 128K. If a live request
  with 128000 returns `REQUEST_BODY_INVALID`, drop to 65536 (both files) and
  capture the request/response to document the real ceiling.
- **O3 — region confirmation** for `eu-central-1`.

If a capture is warranted, the tooling already exists in `kiro-capture/`:
- `run_mitm.bat` starts mitmproxy with the `kiro_capture.py` addon (redacts
  auth/tokens, skips telemetry, writes numbered request/response files).
- Point Kiro CLI/IDE (or the extension via `HTTPS_PROXY`) at the mitm proxy, pick
  Sonnet 5, send one prompt, and read the `NN-POST-runtime.*.request.json` +
  `.response.txt` pair. Compare the `additionalModelRequestFields` / `max_tokens`
  the official client sends against what the extension sends.

This is the same, proven method used for the earlier `runtime.kiro.dev` migration
(captures 03–14). It stays a fallback, not a prerequisite.

---

## Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Only `models.ts` updated, `adaptive-thinking.ts` forgotten | High (both ref PRs did this) | Spec makes the two-file edit the headline; tests assert `isAdaptiveThinkingSupported` + payload |
| `max_tokens: 128000` rejected by Kiro for Sonnet 5 | Low–Med | Live smoke; fall back to 65536 + capture (O2) |
| Sonnet 5 not actually in `eu-central-1` yet (gradual rollout) | Low–Med | Confirm with EU credential; if absent, remove from `eu-central-1` set only (O3) |
| Effort-map mismatch between the two files | Med if hand-edited | Tests assert exact `mapOmpEffortToKiroEffort` outputs |
| Refusal stop reason confuses downstream | Low | Passes through as normal stop; optional follow-up to label it |

---

## Open questions

- **O1 — `defaultOmpEffort`:** `medium` (recommended) or `high`? One-line choice.
- **O2 — `maxTokens`:** ship 128000 (official) and fall back on 400, or start
  conservative at 65536 like the ref PRs? Recommendation: 128000, verify live.
- **O3 — `eu-central-1`:** include at launch (blog says yes) or gate on an EU
  credential confirmation? Recommendation: include, verify, remove only if the API
  rejects.

## Out of scope / future

- Special-casing `stop_reason: "refusal"` to show a clear "request refused" message.
- Auto-updating `contextWindow`/`maxTokens` from the live `ListAvailableModels`
  cache (the cache path exists in `models.ts` but the static catalog is the source
  of truth for these fields today).
