# Migration Handoff — omp-provider-kiro → latest kiro-cli supported format

> **Audience:** an implementing agent with NO access to the prior research
> conversation. This file is self-contained. Everything below is grounded in
> repo files, the live kiro-cli SQLite DB, and decoded network captures under
> `kiro-capture/` (kiro-cli 2.11.1, both classic and `--v3`). Companion analysis
> lives in `docs/omp-provider-kiro-migration-research.md`.
>
> **Scope of this doc:** what changed in the latest kiro-cli, what the extension
> must do about it, and exactly where in the code. Ordered, with acceptance
> criteria. Do NOT treat any item as done until its acceptance check passes.

Date compiled: 2026-07-08. Verified against kiro-cli **2.11.1**.

---

## 0. Executive summary

The extension is already OMP-native and already targets the current Kiro API
(`runtime.{region}.kiro.dev` / `GenerateAssistantResponse`). The latest kiro-cli
introduced **no breaking wire or auth changes**. Two **additive** wire fields
appeared, and one long-standing extension bug (dropped reasoning stream) is the
highest-value fix. Concretely:

| # | Work item | Type | Risk | File(s) |
|---|---|---|---|---|
| M1 | Show thinking: parse `reasoningContentEvent` | Bug fix (high value) | Low | `event-parser.ts`, `stream.ts` |
| M2 | Read `stopReason` from `assistantResponseEvent` | Additive robustness | Low | `event-parser.ts`, `stream.ts` |
| M3 | Confirm `additionalModelRequestFields` shape matches kiro-cli default | Validation (likely no-op) | Low | `adaptive-thinking.ts`, `stream.ts` |
| M4 | Add `KIRO_API_KEY` credential source | New feature | Low | `oauth.ts`/`kiro-cli.ts`, `index.ts` |
| M5 | (Optional) v3 kiro-cli test fixture | Test hygiene | None | `test/kiro-cli.test.ts` |
| M6 | OMP dependency bump 16.1.1 → latest | Maintenance | Low | `package.json` |

Auth requires **no code change** for kiro-cli-latest (see §2). Do M1 first.

---

## 1. Verified facts (do not re-investigate; these are ground truth)

### 1.1 Auth / credential store — UNCHANGED across v2 and v3

Live inspection of `%LOCALAPPDATA%\Kiro-Cli\data.sqlite3` after a full
logout + `kiro-cli --v3 login` (IAM Identity Center):

- DB path unchanged: `%LOCALAPPDATA%\Kiro-Cli\data.sqlite3` (Windows).
- Table `auth_kv` unchanged.
- Keys unchanged: `kirocli:odic:token`, `kirocli:odic:device-registration`
  (the `odic` spelling is a kiro-cli typo — match it verbatim; the extension
  already does).
- Token JSON fields unchanged: `access_token, refresh_token, expires_at,
  region, scopes, start_url, oauth_flow`.
- Device-registration fields unchanged: `client_id, client_secret,
  client_secret_expires_at, region, scopes, oauth_flow`.
- Schema version unchanged (migrations count 10, last version 9).

`profile_arn` is NOT present in an IdC token JSON; `tryKiroCliToken()` already
treats it as optional and derives region from `start_url`/scopes. Handled.

**Implication:** `src/kiro-cli.ts` needs no change for latest kiro-cli auth.

### 1.2 Wire API — endpoint UNCHANGED, two additive fields

Fresh capture from kiro-cli 2.11.1 (classic mode) vs June baseline
(kiro-cli 2.6.1). Both hit:
- Host: `runtime.{region}.kiro.dev` (e.g. `runtime.eu-central-1.kiro.dev`)
- `X-Amz-Target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse`
- Body: `conversationState { conversationId, history, currentMessage,
  chatTriggerType, agentTaskType }` with
  `currentMessage.userInputMessage { content, userInputMessageContext{envState,
  tools}, origin, modelId }`.

**NEW in request (additive):** a top-level `additionalModelRequestFields`
sibling of `conversationState`/`profileArn`:
```json
{
  "conversationState": { ... },
  "profileArn": "arn:aws:codewhisperer:...:profile/...",
  "additionalModelRequestFields": { "output_config": { "effort": "high" } }
}
```
This is the `top-level-wrapper` shape with the `effort-only` field-set that
`src/adaptive-thinking.ts` already documents and can emit. kiro-cli sent
`effort: "high"` (its TUI default).

**NEW in response (additive):** `assistantResponseEvent` now carries
`"stopReason":"END_TURN"`. The June baseline did not. The extension currently
ignores it (safe).

Everything else identical: `contextUsageEvent`, `initial-response`, the AWS
eventstream binary framing, `chatTriggerType: MANUAL`, `agentTaskType: vibe`.

### 1.3 Reasoning stream — the extension drops it (root cause of "no thinking")

The Kiro runtime emits reasoning as a **distinct AWS eventstream event**, not as
inline `<thinking>` tags. Event types observed on a reasoning turn (June
capture `03-POST-runtime.*.response.txt`):
```
initial-response | reasoningContentEvent (×28) | assistantResponseEvent (×40) | contextUsageEvent
```
- `assistantResponseEvent` → `{"content":"..."}` — the answer text.
- `reasoningContentEvent` → `{"text":"..."}` interleaved with a final
  `{"signature":"Eq..."}` — the model's native reasoning stream (`signature`
  is the Anthropic thinking-block signature).

`src/event-parser.ts` `parseKiroEvent()` recognizes only `content`,
`name/toolUseId`, `input`, `stop`, `contextUsagePercentage`, `followupPrompt`,
`usage`, `error`. **There is no `reasoningContentEvent` branch** — those frames
return `null` and are silently dropped. `src/thinking-parser.ts`
(`ThinkingTagParser`) only handles inline `<thinking>`/`<think>`/`<reasoning>`/
`<thought>` tags in the *content* text — a legacy path the current API never
uses. Hence reasoning is never surfaced to pi.

**CRITICAL — what actually triggers `reasoningContentEvent` (corrected):** it is
**the effort tier, NOT the prompt and NOT model capability alone.** The Kiro
runtime streams a visible reasoning stream ONLY at the top effort tier
(`output_config.effort: "max"`); at `high`/`xhigh`/`low`/none the model reasons
internally and the runtime emits ONLY the final answer. Verified correlation
across all captures:

| effort sent | model | reasoningContentEvent? |
|---|---|---|
| `max` | claude-opus-4.8 | **YES** (13 frames June 2.6.1; 32 frames 2.11.1) |
| `xhigh` | claude-opus-4.7 | no |
| `high` | claude-sonnet-4.6 | no (even on a hard multi-step puzzle) |
| `low` | claude-opus-4.8 | no |
| none | haiku / opus-4.8 | no |

The bat-and-ball prompt streamed 13 frames at `max` but zero at `high` — proving
content is irrelevant. This is unchanged between kiro-cli 2.6.1 and 2.11.1.
Effort ladder (`adaptive-thinking.ts`): OMP `xhigh` → Kiro `max` on five-tier
models, so the extension surfaces reasoning only when the user picks the top
effort on a `max`-capable model (opus-4.8 in the observed data).

**M1 fixture:** use **`05-POST-runtime.*.response.txt`** — the LATEST-version
(2.11.1) capture with 32 `reasoningContentEvent` frames at `effort: max`. (The
June `03` capture, 28 frames, is an older-version secondary fixture.) Do NOT
expect reasoning at `high`/`low`/none — those "answer-only" turns are correct
behavior, not a regression.

### 1.4 Adaptive thinking effort vs. thinking display — two different things

- **Display** (surfacing `reasoningContentEvent`) does NOT change answer quality;
  it just shows tokens already generated/billed. This is M1.
- **Effort** (`additionalModelRequestFields.output_config.effort`) DOES change
  quality/cost. The extension already sends this via `adaptive-thinking.ts`
  (enabled by default). This is M3 (validation only).

### 1.5 v3 specifics (informational; not blocking)

- kiro-cli v3 is the same binary via `kiro-cli --v3`; auth store identical (§1.1).
- v3 routes the model call through a separate `kas` agent-server sidecar, which
  bypassed the capture proxy — so the v3 `GenerateAssistantResponse` wire was
  not directly captured. Irrelevant to the extension: **the extension calls the
  Kiro runtime API itself and never goes through `kas`.** The v2 wire (§1.2) is
  the authoritative contract for the extension.
- v3 added telemetry sinks (`prod.us-east-1.telemetry-v2.kiro.dev` OTLP,
  `cognito-identity.us-east-1` for telemetry creds). Not part of chat/auth.

---

## 2. Work items (ordered, with exact locations + acceptance)

### M1 — Show thinking: parse `reasoningContentEvent` (do first)

**Goal:** surface the model's reasoning stream to pi as reasoning/thinking
content instead of dropping it.

**Where:**
- `src/event-parser.ts`:
  - Add a `reasoning` variant to the `KiroStreamEvent` union, e.g.
    `{ type: "reasoning"; data: { text?: string; signature?: string } }`.
  - In `parseKiroEvent()`, detect reasoning frames. NOTE the parser is currently
    keyed on JSON object keys, and `reasoningContentEvent` payloads are
    `{"text":...}` and `{"signature":...}`. A bare `{"text":...}` is ambiguous
    with other shapes, so you MUST disambiguate by the **AWS eventstream
    `:event-type` header** (`reasoningContentEvent` vs `assistantResponseEvent`),
    not by JSON keys alone. Check how the raw framing is currently split — see
    `EVENT_PATTERNS` and `findJsonEnd()` in `event-parser.ts`, and the stream
    reader in `stream.ts`. The event-type name is in the binary frame preceding
    each JSON payload (`:event-type\x07\x00<len><name>`). The parser may need to
    receive the event-type alongside the JSON.
- `src/stream.ts`: in the stream consumption loop (search for where
  `parseKiroEvents`/`ThinkingTagParser` are used, around the
  `thinkingParser`/`textBlockIndex` logic), route `reasoning` events into pi's
  reasoning/`ThinkingContent` output path. pi exposes `ThinkingContent` and a
  reasoning event on `AssistantMessageEventStream` (see how `ThinkingTagParser`
  currently emits thinking via `emitThinking()` in `thinking-parser.ts` for the
  target shape). Accumulate `text` deltas into a thinking block; attach the
  `signature` if pi's thinking content supports a signature field.
- Keep the legacy `ThinkingTagParser` inline-tag path for models that still emit
  tags, OR confirm it's dead and remove — but M1's new path must not
  double-emit. Reasoning-capable models should use the event path; guard on
  `model.reasoning`.

**Watch:** the binary framing. `reasoningContentEvent` and
`assistantResponseEvent` both contain `{"text"...}`/`{"content"...}`; only the
event-type header distinguishes reasoning `text` from other `text`. Get the
framing right or reasoning text will leak into the answer or vice-versa.

**Acceptance:**
- Add a unit test in `test/event-parser.test.ts` (or `stream.test.ts`) that
  feeds the **`05-POST-runtime.*.response.txt`** bytes (2.11.1 capture, 32
  `reasoningContentEvent` frames at `effort: max`, opus-4.8) and asserts the
  reasoning text is emitted as thinking/reasoning content, separate from the
  answer content, in order, with the trailing `signature` attached.
- The answer-only case (a `high`/`low`/none-effort turn: only
  `assistantResponseEvent`, no reasoning) still produces answer-only output with
  no empty thinking block. This is expected behavior, NOT a regression — only
  `effort: max` streams reasoning.
- `npm test` green; `npm run check` clean.

### M2 — Read `stopReason` from `assistantResponseEvent`

**Goal:** consume the new additive `stopReason` field (`END_TURN`, etc.) for
correct turn-termination semantics instead of inferring it.

**Where:** `src/event-parser.ts` (extend the `content`/assistantResponse branch
to also surface `stopReason` when present); `src/stream.ts` (use it to set the
pi stop reason / end the turn cleanly).

**Acceptance:** a test asserting `stopReason: "END_TURN"` is parsed from the new
v2 capture `04-POST-runtime.*.response.txt`; behavior unchanged when the field is
absent (older streams). `npm test` green.

### M3 — Validate `additionalModelRequestFields` matches kiro-cli default

**Goal:** confirm the extension's emitted adaptive-thinking payload matches what
kiro-cli 2.11.1 sends (`{ output_config: { effort } }` at top level).

**Where:** `src/adaptive-thinking.ts` (default shape `top-level-wrapper`,
field-set knob `full` vs `effort-only`), `src/stream.ts`
(`applyAdaptivePayloadShape`).

**Facts:** kiro-cli sends the **`effort-only`** field-set
(`{ output_config: { effort } }`) at the **top level**. The extension defaults to
the `full` field-set (`{ thinking, output_config, max_tokens }`), also valid and
live-verified 200-OK. Decide whether to keep `full` (future-proof, works) or
switch the default to `effort-only` to mirror kiro-cli exactly. This is a
judgment call — document the choice; do not silently change behavior.

**Acceptance:** capture `04-POST-runtime.*.request.json` shows
`additionalModelRequestFields.output_config.effort`. A test asserts the
extension produces a byte-compatible top-level shape for a reasoning model at a
given effort. No ValidationException on a live turn. `npm test` green.

### M4 — Add `KIRO_API_KEY` credential source

**Goal:** support the version-independent API-key auth path (no SQLite, no OAuth
device flow). Kiro docs: `export KIRO_API_KEY=ksk_...`; precedence in kiro-cli is
browser session → `KIRO_API_KEY` → prompt. Paid-tier feature (Pro/Pro+/Pro
Max/Power); credits decrement from subscription.

**Where:** add to the credential cascade. Current cascade (per `AGENTS.md` +
`kiro-cli.ts`/`oauth.ts`): kiro-cli social token → IDC token → OAuth device flow.
Insert an `env(KIRO_API_KEY)` source — likely highest or second-highest priority
when set. Wire through `src/index.ts` `oauth`/`getCliCredentials` and the bearer
used in `stream.ts` (`Authorization: Bearer <key>`). Confirm whether the key is
sent verbatim as the bearer against `runtime.{region}.kiro.dev` (validate with a
capture or a live turn) — the wire auth header for token auth is
`Authorization: Bearer <access_token>`; an API key likely uses the same header.

**Acceptance:** with `KIRO_API_KEY` set and no kiro-cli login, a live streaming
turn succeeds. Unit test for the credential-resolution precedence. `npm test`
green. Flag clearly in code/docs that this is a paid-tier credential.

### M5 — (Optional) v3 kiro-cli test fixture

**Goal:** lock in that v3's identical credential store is covered. Since keys and
fields are unchanged (§1.1), this is a no-op fixture confirming
`getKiroCliCredentials()` resolves the same way against a v3-shaped `auth_kv`
row. Low priority.

### M6 — OMP dependency bump (16.1.1 → latest)

**Goal:** move `@oh-my-pi/pi-ai` and `@oh-my-pi/pi-coding-agent` to latest.
Independent of the kiro-cli work; do it on its own branch.

**Where:** `package.json` devDeps. Prior analysis found no extension-facing
breaking changes 16.1.1 → 16.3.11 (surfaces used: `registerProvider`,
`ProviderConfigInput.oauth`, `streamSimple`, `Effort`, `SimpleStreamOptions`,
`createAssistantMessageEventStream`, `toolWireSchema`). Re-check the changelog for
anything past 16.3.11 at implementation time.

**Watch:** the intentional `as any` on `oauth` in `src/index.ts` — current OMP
`ProviderConfigInput.oauth` does not type `getCliCredentials`/`fetchUsage`; a
repo grep of the OMP fork found no runtime consumer of `getCliCredentials`, so it
may be dead. Verify and note/remove during the bump.

**Acceptance:** `npm run check` clean, `npm test` green (248 tests baseline),
one live streaming turn confirmed.

---

## 3. Evidence index (files to read before implementing)

- **Live DB:** `%LOCALAPPDATA%\Kiro-Cli\data.sqlite3` (kiro-cli 2.11.1). Read
  `auth_kv` with `bun:sqlite` `new Database(path,{readonly:true})` or
  `node:sqlite` `DatabaseSync`.
- **Captures (`kiro-capture/`):**
  - **NOTE: capture files renumber every run.** Identify captures by
    host + decoded content, not by number. The relevant ones (as of this
    session, all kiro-cli 2.11.1 unless noted):
  - `05-POST-runtime.*.response.txt` — **M1 fixture.** opus-4.8 at
    `effort: max`; 32 `reasoningContentEvent` frames (`{"text":...}` + trailing
    `{"signature":...}`) plus `assistantResponseEvent` + `stopReason: END_TURN`.
  - `05-POST-runtime.*.request.json` — matching request:
    `additionalModelRequestFields.output_config.effort = "max"`, model
    claude-opus-4.8.
  - Other 2.11.1 runtime captures this session (sonnet-4.6 / opus at
    `high`) — answer-only, `stopReason: END_TURN`, NO reasoning frames; useful as
    the negative case for the M1 test.
  - Older June (2.6.1) captures also contain a `max`/opus-4.8 reasoning stream
    (secondary fixture) and a pre-`additionalModelRequestFields` request shape
    for the request diff.
  - Decode event-type names from the binary framing with:
    `/:event-type\x07\x00.([\x20-\x7e]{5,40}?)(?:\r|:content-type)/g`.
- **Capture tool:** `kiro-capture/kiro_capture.py` (mitmproxy addon; targets
  `*.kiro.dev`/`*.amazonaws.com`, redacts auth). Runbook + CA-trust recipe in
  `docs/omp-provider-kiro-migration-research.md` §3.4.
- **Code:** `src/event-parser.ts`, `src/thinking-parser.ts`, `src/stream.ts`,
  `src/adaptive-thinking.ts`, `src/kiro-cli.ts`, `src/oauth.ts`, `src/models.ts`,
  `src/index.ts`, `src/transform.ts`.
- **Kiro docs:** `/docs/cli/authentication/` (KIRO_API_KEY, precedence),
  `/docs/cli/experimental/thinking/` (display vs tool), `/docs/cli/v3/`.

---

## 4. Suggested branch/PR sequence

1. **M6** (OMP bump) — isolated, green baseline first.
2. **M1** (reasoning display) — highest value; test with June fixtures.
3. **M2** (stopReason) — small, pairs naturally with M1's parser work.
4. **M3** (adaptive payload validation) — likely no-op; document the field-set
   decision.
5. **M4** (`KIRO_API_KEY`) — independent feature; reduces SQLite-coupling
   fragility.
6. **M5** (v3 fixture) — optional hygiene.

Each item: skip project-wide reformat/lint churn; run `npm run check` + `npm
test` per change; confirm one live streaming turn for M1/M3/M4.

---

## 5. Non-goals / explicitly out of scope

- No change to the credential store parsing for kiro-cli-latest (auth is
  byte-identical — §1.1).
- No new wire protocol / endpoint work (endpoint + target unchanged — §1.2).
- Do not route the extension through the v3 `kas` sidecar (extension calls the
  Kiro API directly).
- Do not remove the legacy `<thinking>`-tag path in `thinking-parser.ts` unless
  you prove it's dead for all models the extension supports.
