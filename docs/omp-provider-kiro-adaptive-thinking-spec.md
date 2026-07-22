# Spec: Migrate `omp-provider-kiro` to the Current Kiro API + Adaptive Thinking

> **Historical specification:** hardcoded adaptive model tables in this document are superseded by live Kiro schema mapping through OMP-native dynamic discovery. See `README.md`, `AGENTS.md`, and `docs/kiro-model-discovery-research.md`.


Repo: https://github.com/ajdiyassin/omp-provider-kiro

> **Status:** Rewritten 2026-06-12 after capturing real `kiro-cli` (AmazonQ-For-CLI 2.6.1)
> traffic via mitmproxy. All wire shapes, endpoints, model schemas, and effort values in
> this document are taken from those captures (see [Appendix A](#appendix-a--capture-evidence)),
> not from guesses. The previous version of this spec (legacy Anthropic extended-thinking
> with invented budgets, single `q.{region}.amazonaws.com` endpoint, opus-4.8 + sonnet-4.6
> only) is **superseded** — see [Appendix B](#appendix-b--what-changed-from-the-previous-spec).

---

## Purpose

The extension was built against the **old Amazon Q / CodeWhisperer** surface:

- It calls `https://q.{region}.amazonaws.com/generateAssistantResponse` (chat) and
  `https://q.{region}.amazonaws.com/ListAvailableModels`.
- It enables "thinking" by injecting legacy Anthropic extended-thinking XML into the
  system prompt with **invented** budget numbers:

  ```xml
  <thinking_mode>enabled</thinking_mode>
  <max_thinking_length>50000|30000|20000|10000</max_thinking_length>
  ```

The current `kiro-cli` no longer works this way. This spec migrates the provider to the
**current Kiro API** and the **official adaptive-thinking mechanism**, and drops all
deprecated/outdated paths (no backward-compat with the old Q endpoint or legacy thinking).

Goals:

1. Switch all endpoints to the current Kiro hosts (`runtime`/`management.{region}.kiro.dev`).
2. Remove legacy extended-thinking XML injection and the invented budgets entirely.
3. Implement official adaptive thinking via the top-level `additionalModelRequestFields`.
4. Support **all** adaptive models: `claude-opus-4.8`, `claude-opus-4.7`, `claude-opus-4.6`,
   `claude-sonnet-4.6`.
5. Map OMP effort levels to Kiro effort correctly, per model.
6. Send the **full** model-config payload (`thinking` + `output_config` + `max_tokens`),
   not a partial one, so future models/updates are handled by data, not code.
7. Mimic the real `kiro-cli` request shape as closely as practical.

---

## Confirmed Kiro API (from capture)

### Endpoints

| Purpose | Method | Host / path | `X-Amz-Target` |
|---|---|---|---|
| Chat (streaming) | POST | `https://runtime.{region}.kiro.dev/` | `AmazonCodeWhispererStreamingService.GenerateAssistantResponse` |
| List models | POST | `https://management.{region}.kiro.dev/` | `AmazonCodeWhispererService.ListAvailableModels` |
| Get profile | POST | `https://management.{region}.kiro.dev/` | `AmazonCodeWhispererService.GetProfile` |
| List profiles (profileArn resolution) | POST | `https://management.{region}.kiro.dev/` | `AmazonCodeWhispererService.ListAvailableProfiles` |

- `{region}` is the Kiro API region (`us-east-1` or `eu-central-1`). The existing
  SSO→API region resolution stays, but the **host changes from `q.{region}.amazonaws.com`
  to `{runtime|management}.{region}.kiro.dev`**.
- The legacy `q.{region}.amazonaws.com/generateAssistantResponse` path is **removed**.

### Request headers (chat)

Match `kiro-cli` 2.6.x:

```text
content-type: application/x-amz-json-1.0
x-amz-target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse
authorization: Bearer <accessToken>
user-agent: aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.16551 os/windows lang/rust/1.92.0 exec-env/AmazonQ-For-CLI Version/2.6.1 md/appVersion-2.6.1 app/AmazonQ-For-CLI
x-amz-user-agent: <same as user-agent, with m/F>
x-amzn-codewhisperer-optout: false
amz-sdk-request: attempt=1; max=3
amz-sdk-invocation-id: <uuid>
accept: */*
```

Notes:
- The previous code sent `x-amzn-codewhisperer-optout: true` and a fabricated
  `AmazonQ-For-CLI-1.28.3` UA. Update both to match the captured CLI.
- Response is `application/vnd.amazon.eventstream` (AWS event-stream framing).

### Request body (chat) — exact captured shape

```jsonc
{
  "conversationState": {
    "conversationId": "<uuid>",
    "history": [
      { "userInputMessage": {
          "content": "…",
          "userInputMessageContext": {
            "envState": { "operatingSystem": "windows", "currentWorkingDirectory": "C:\\…" }
            // plus "tools" / "toolResults" when present
          },
          "origin": "KIRO_CLI",
          "modelId": "claude-opus-4.8"
      } },
      { "assistantResponseMessage": { "content": "…" } }
    ],
    "currentMessage": {
      "userInputMessage": {
        "content": "…",
        "userInputMessageContext": {
          "envState": { "operatingSystem": "windows", "currentWorkingDirectory": "C:\\…" },
          "tools": [ { "toolSpecification": { "name", "description", "inputSchema": { "json": {…} } } } ]
        },
        "origin": "KIRO_CLI",
        "modelId": "claude-opus-4.8"
      }
    },
    "chatTriggerType": "MANUAL",
    "agentContinuationId": "<uuid>",
    "agentTaskType": "vibe"
  },
  "profileArn": "arn:aws:codewhisperer:{region}:{account}:profile/{id}",
  "additionalModelRequestFields": {
    "thinking": { "type": "adaptive", "display": "summarized" },
    "output_config": { "effort": "max" },
    "max_tokens": 128000
  }
}
```

Key structural facts confirmed from the capture:

- **`additionalModelRequestFields` is a top-level key** of the request body — a sibling of
  `conversationState` and `profileArn`. It is **not** spread into the body and **not** nested
  inside `userInputMessage`.
- `modelId` lives inside each `userInputMessage` (history and current), in **dotted** form
  (`claude-opus-4.8`).
- `userInputMessageContext.envState` (`operatingSystem`, `currentWorkingDirectory`) is sent
  on every `userInputMessage`. Our provider currently omits it — **add it**.
- `conversationState` carries `agentContinuationId` (uuid) and `agentTaskType: "vibe"`.
  The previous top-level `agentMode: "vibe"` is **not** sent by the CLI — **remove it**.
- `chatTriggerType: "MANUAL"`, `origin: "KIRO_CLI"`, top-level `profileArn` — unchanged.

### `additionalModelRequestFields` schema (authoritative, from `ListAvailableModels`)

`ListAvailableModels` returns a per-model `additionalModelRequestFieldsSchema`. For the
adaptive models it is:

```jsonc
// claude-opus-4.8  (and 4.7: same shape, effort.default = "xhigh")
{
  "type": "object",
  "properties": {
    "thinking": {
      "type": "object",
      "properties": {
        "type":    { "type": "string", "enum": ["adaptive", "disabled"] },
        "display": { "type": "string", "enum": ["summarized", "omitted"] }
      },
      "required": ["type"]
    },
    "output_config": {
      "properties": { "effort": { "enum": ["low","medium","high","xhigh","max"], "default": "high" } }
    }
  },
  "max_tokens": { "type": "integer", "minimum": 1024, "maximum": 128000 },
  "additionalProperties": false
}
```

Models **without** this schema (`auto`, `claude-opus-4.5`, `claude-sonnet-4.5`,
`claude-sonnet-4`, `claude-haiku-4.5`, `minimax-*`, `qwen*`, `glm*`, `deepseek-*`) are
**non-adaptive** and must never receive `additionalModelRequestFields`.

### Response stream (confirmed)

Responses stream AWS event-stream frames; each frame payload is the **simple** form:

```text
:event-type assistantResponseEvent  → {"content":"…","modelId":"…"}
:event-type contextUsageEvent       → {"contextUsagePercentage": …}
:event-type meteringEvent           → {"unit":"credit","usage": …}
```

A step-by-step reasoning prompt at `high`/`max` effort streamed reasoning **inline as
normal `content`** — no separate `reasoningContent` / nested `contentBlockDeltaEvent`
events appeared. The existing `src/event-parser.ts` already parses `{"content":…}`,
`contextUsagePercentage`, tool, and usage events. **No response-parser changes are
required.** (Native nested-`reasoningContent` parsing is optional/defensive only.)

---

## Supported adaptive models (live data)

| OMP id (`-`) | Kiro id (`.`) | Tier | Kiro efforts | Server default | `max_tokens` cap |
|---|---|---|---|---|---|
| `claude-opus-4-8` | `claude-opus-4.8` | 5-tier | low, medium, high, xhigh, max | high | 128000 |
| `claude-opus-4-7` | `claude-opus-4.7` | 5-tier | low, medium, high, xhigh, max | xhigh | 128000 |
| `claude-opus-4-6` | `claude-opus-4.6` | 4-tier | low, medium, high, max | high | 64000 |
| `claude-sonnet-4-6` | `claude-sonnet-4.6` | 4-tier | low, medium, high, max | high | 64000 |

All four are available in `us-east-1` and `eu-central-1`. Every other Kiro model stays
callable but receives **no** adaptive fields.

---

## OMP integration: effort mapping

OMP exposes thinking levels via `options.reasoning` using the `Effort` union
(`minimal | low | medium | high | xhigh`) and per-model `model.thinking` metadata
(`ThinkingConfig` from `@oh-my-pi/pi-catalog`). OMP role selectors look like
`kiro/claude-opus-4-8:xhigh`, `kiro/claude-sonnet-4-6:medium`.

OMP has 5 selectors (`minimal…xhigh`, no `max`); Kiro 5-tier models have `low…max`. So a
per-model map is required:

| OMP level | Opus 4.8 / 4.7 (5-tier) → Kiro | Opus 4.6 / Sonnet 4.6 (4-tier) → Kiro |
|---|---|---|
| `minimal` | `low` | `low` |
| `low` | `medium` | `low` |
| `medium` | `high` | `medium` |
| `high` | `xhigh` | `high` |
| `xhigh` | `max` | `max` |

Rationale: Kiro/Anthropic document `xhigh` for Opus 4.8/4.7 but only up to `max` for Opus 4.6
and Sonnet 4.6. OMP's top selector (`xhigh`) always maps to Kiro `max`.

Constraints:
- The extension must **not** implement its own `/effort` command.
- The extension must **not** read `kiro-cli`'s `/effort` setting as the source of truth.
- OMP role config (`options.reasoning`) is the source of truth for OMP sessions.
- `auto` and non-adaptive models never receive adaptive fields.

---

## Target design

### New module: `src/adaptive-thinking.ts`

Single source of truth for adaptive-model config + mapping + payload building.

```ts
export type OmpEffort  = "minimal" | "low" | "medium" | "high" | "xhigh";
export type KiroEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type KiroAdaptivePayload = {
  thinking: { type: "adaptive"; display: "summarized" | "omitted" };
  output_config: { effort: KiroEffort };
  max_tokens: number;
};

// Keyed by OMP model id (dash form). One entry per adaptive model.
const KIRO_ADAPTIVE_MODELS = {
  "claude-opus-4-8": {
    kiroModelId: "claude-opus-4.8",
    maxTokens: 128000,
    effortMap: { minimal: "low", low: "medium", medium: "high", high: "xhigh", xhigh: "max" },
  },
  "claude-opus-4-7": {
    kiroModelId: "claude-opus-4.7",
    maxTokens: 128000,
    effortMap: { minimal: "low", low: "medium", medium: "high", high: "xhigh", xhigh: "max" },
  },
  "claude-opus-4-6": {
    kiroModelId: "claude-opus-4.6",
    maxTokens: 64000,
    effortMap: { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max" },
  },
  "claude-sonnet-4-6": {
    kiroModelId: "claude-sonnet-4.6",
    maxTokens: 64000,
    effortMap: { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max" },
  },
} as const;

export function isAdaptiveThinkingSupported(modelId: string): boolean;
export function mapOmpEffortToKiroEffort(modelId: string, effort: OmpEffort | undefined): KiroEffort | undefined;

// Builds the FULL payload (thinking + output_config + max_tokens) for adaptive models;
// returns undefined for non-adaptive models and `auto`.
export function buildKiroAdaptiveThinkingPayload(
  modelId: string,
  ompEffort: OmpEffort | undefined,
): KiroAdaptivePayload | undefined;
```

Behavior:

- For adaptive models, always emit the **full** block:
  `{ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort }, max_tokens: <cap> }`.
- `effort` falls back to the model's sensible default when `options.reasoning` is absent
  (Opus 4.8 → `high`, Opus 4.7 → `xhigh`, Opus 4.6 → `high`, Sonnet 4.6 → `high` — i.e. the
  server defaults, expressed via the OMP level that maps to them).
- `KIRO_ADAPTIVE_THINKING=0` → omit `thinking` and `output_config` (debug escape hatch).
  Do **not** add any XML fallback.
- Non-adaptive models / `auto` → return `undefined` (no key emitted).

> **Future-proofing (recommended follow-up):** `ListAvailableModels` returns
> `additionalModelRequestFieldsSchema` per model. A later enhancement can build
> `KIRO_ADAPTIVE_MODELS` dynamically from that schema (effort enum, default, `max_tokens`
> max) so new models become adaptive automatically. MVP uses the static table above.

### Stream integration (`src/stream.ts`)

Remove:

```ts
// DELETE — legacy extended-thinking XML + invented budgets
if (thinkingEnabled) {
  const budget = options?.reasoning === "xhigh" ? 50000 : … ;
  systemPrompt = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>…`;
}
```

Keep the system prompt plain. After `kiroModelId` resolves, build and attach the payload:

```ts
const adaptive = buildKiroAdaptiveThinkingPayload(model.id, options?.reasoning as OmpEffort | undefined);

const request: KiroRequest = {
  conversationState: {
    chatTriggerType: "MANUAL",
    agentTaskType: "vibe",
    agentContinuationId: conversationId,            // uuid per conversation
    conversationId,
    currentMessage: { userInputMessage: { …, userInputMessageContext: { envState, tools?, toolResults? } } },
    ...(history.length > 0 ? { history } : {}),
  },
  ...(profileArn ? { profileArn } : {}),
  ...(adaptive ? { additionalModelRequestFields: adaptive } : {}),
};
```

- `additionalModelRequestFields` is added **only** when `adaptive` is defined (adaptive model,
  not `auto`, not disabled via env).
- Add `envState = { operatingSystem, currentWorkingDirectory }` to every `userInputMessage`
  (history + current).
- Remove the top-level `agentMode` field.

### Endpoint / host changes (`src/models.ts`, `src/stream.ts`, `src/usage.ts`)

- `endpointForApiRegion(region)` → `https://runtime.{region}.kiro.dev/`
  (chat `GenerateAssistantResponse`). Note: the path is `/` and the operation is selected by
  the `X-Amz-Target` header (not a `/generateAssistantResponse` path).
- `ListAvailableModels`, `GetProfile`, `ListAvailableProfiles` → `https://management.{region}.kiro.dev/`
  via `X-Amz-Target` (AWS JSON 1.0 POST to `/`), replacing the `q.{region}.amazonaws.com/...` GET/paths.
- `extractRegionFromEndpoint` must recognize `*.kiro.dev` hosts.
- Drop all `q.{region}.amazonaws.com` usage.

### Model metadata (`src/models.ts`)

- Remove the dead `thinkingLevelMap: { xhigh: "xhigh" }` (OMP ignores it).
- Add real `thinking: ThinkingConfig` to the four adaptive models:

  ```ts
  // claude-opus-4-8 (4-7 identical except defaultLevel: "high")
  thinking: {
    mode: "anthropic-adaptive",
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
    defaultLevel: "medium",            // → Kiro "high" (server default for 4.8)
    effortMap: { minimal: "low", low: "medium", medium: "high", high: "xhigh", xhigh: "max" },
    supportsDisplay: true,
  }
  // claude-opus-4-6 / claude-sonnet-4-6
  thinking: {
    mode: "anthropic-adaptive",
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
    defaultLevel: "high",              // → Kiro "high" (server default)
    effortMap: { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max" },
    supportsDisplay: true,
  }
  ```

  (`claude-opus-4-7` uses the 5-tier map with `defaultLevel: "high"` → Kiro `xhigh`.)

- Non-adaptive models: leave callable, no `thinking` metadata, `reasoning` left as-is for
  non-thinking purposes but **must not** gain adaptive fields.
- Dynamic-cache model construction (`updateKiroModelsCache`) must **not** mark generated
  models `reasoning: true` purely because the id contains `opus`/`sonnet`, and must not add
  `thinking` metadata to anything outside the four adaptive ids.

### Debug logging (`request.init`)

Add:

```ts
adaptiveThinkingEnabled: Boolean(adaptive),
kiroEffort: adaptive?.output_config.effort,
maxTokens: adaptive?.max_tokens,
reasoning: options?.reasoning,
model: model.id,
kiroModelId,
endpoint,
```

Do not log tokens/credentials.

---

## Tests

`test/adaptive-thinking.test.ts` (new):

- `mapOmpEffortToKiroEffort` for all four models × all OMP levels (tables above).
- `buildKiroAdaptiveThinkingPayload`:
  - opus-4.8 `xhigh` → `{ thinking:{type:"adaptive",display:"summarized"}, output_config:{effort:"max"}, max_tokens:128000 }`
  - opus-4.7 `xhigh` → effort `max`, max_tokens `128000`
  - opus-4.6 `xhigh` → effort `max`, max_tokens `64000`
  - sonnet-4.6 `high` → effort `high`, max_tokens `64000`
  - sonnet-4.6 `xhigh` → effort `max`, max_tokens `64000`
  - `claude-haiku-4-5` / `auto` / `qwen3-coder-next` → `undefined`
  - `KIRO_ADAPTIVE_THINKING=0` → no `thinking`/`output_config`.

`test/models.test.ts`: the four adaptive models carry correct `thinking` metadata; others/`auto` do not; dynamic cache doesn't auto-flag.

`test/stream.test.ts`: outgoing request for
- `claude-opus-4-8` + `reasoning:"xhigh"` includes top-level `additionalModelRequestFields`
  with effort `max`, max_tokens `128000`, `thinking.type:"adaptive"`;
- `claude-sonnet-4-6` + `reasoning:"high"` → effort `high`, max_tokens `64000`;
- `claude-haiku-4-5` / `auto` → no `additionalModelRequestFields`;
- request hits `runtime.{region}.kiro.dev`, includes `userInputMessageContext.envState`, and
  has no top-level `agentMode`.

`test/build-output.test.ts` (regression): `thinking_mode|max_thinking_length|50000|30000|20000|10000`
appear in neither `src` (except absence assertions) nor `dist/index.js`; no
`q.{region}.amazonaws.com` host remains.

---

## Manual validation

```powershell
bun run check
bun run test
bun run build
Select-String -Path .\dist\index.js -Pattern "thinking_mode|max_thinking_length|amazonaws"   # expect none
```

Inside OMP (with `KIRO_DEBUG=1`, `KIRO_DEBUG_LOG=...`):

```text
/model kiro/claude-opus-4-8:xhigh   → debug: adaptiveThinkingEnabled:true, kiroEffort:max, maxTokens:128000, endpoint runtime.*.kiro.dev
/model kiro/claude-opus-4-7:xhigh   → kiroEffort:max,  maxTokens:128000
/model kiro/claude-sonnet-4-6:xhigh → kiroEffort:max,  maxTokens:64000
/model kiro/claude-sonnet-4-6:medium→ kiroEffort:medium
/model kiro/claude-haiku-4-5:high   → adaptiveThinkingEnabled:false (no adaptive fields)
```

Confirm the live endpoint returns 200 (no `Improperly formed request`) for each adaptive model.

---

## Done definition

1. All endpoints use `runtime`/`management.{region}.kiro.dev`; `q.{region}.amazonaws.com` is gone.
2. Legacy extended-thinking XML + invented budgets removed from `src`.
3. `additionalModelRequestFields` (full `thinking`+`output_config`+`max_tokens`) sent top-level
   for `claude-opus-4.8/4.7/4.6` and `claude-sonnet-4.6`.
4. Non-adaptive models and `auto` send no adaptive fields.
5. OMP roles work via `kiro/<model>:<level>` with correct per-model effort mapping.
6. Request mirrors `kiro-cli` (envState, agentContinuationId, headers/UA; no `agentMode`).
7. `bun run check`, `bun run test`, `bun run build` pass.
8. Manual OMP smoke tests above pass against the live endpoint.
9. README updated to describe adaptive thinking + the new endpoints, and the
   `output_config.effort` (reasoning depth) vs `max_tokens` (total output cap) distinction.

---

## Appendix A — Capture evidence

Captured with mitmproxy against `kiro-cli` (interactive, EU account) — files in `kiro-capture/`:

- `02-…management….response.txt` — `ListAvailableModels` with per-model
  `additionalModelRequestFieldsSchema` (source for the schema/tier/cap tables).
- `03/05/07-…runtime….request.json` — opus-4.8 at `medium`/`max`/`low`; each shows
  top-level `additionalModelRequestFields.output_config.effort` = the exact `/effort` value.
- `09-…runtime…` — sonnet-4.6 `high`; `11-…runtime…` — opus-4.7 `xhigh`;
  `13-…runtime…` — haiku-4.5 baseline (no `additionalModelRequestFields`).
- `09-…response.txt` — confirms simple `assistantResponseEvent {"content":…}` streaming.

Key empirical findings:
- Interactive chat emits `additionalModelRequestFields`; `--no-interactive` one-shot did not
  (it stripped the inference config). The interactive path is authoritative.
- `/effort <level>` maps **1:1** to `output_config.effort` (CLI does no remapping).
- The CLI omitted `thinking`/`max_tokens` when only `output_config.effort` was configured in
  settings, but the server schema accepts all three; this spec sends the full block by design.

## Appendix B — What changed from the previous spec

| Previous spec | Now |
|---|---|
| Endpoint `q.{region}.amazonaws.com/generateAssistantResponse` | `runtime.{region}.kiro.dev/` (chat), `management.{region}.kiro.dev/` (models/profile) |
| Adaptive fields spread at top level (`{...body, ...adaptive}`) | Wrapped in one top-level key `additionalModelRequestFields` |
| Models: opus-4.8 + sonnet-4.6 only; "4.7/4.6 not supported" | All four adaptive: opus-4.8, opus-4.7, opus-4.6, sonnet-4.6 |
| `max_tokens` heuristic (128000 if xhigh else 64000) | Per-model cap: 128000 (opus 4.8/4.7), 64000 (opus 4.6 / sonnet 4.6); always sent |
| Partial payload (effort only, conditionally) | Full payload (`thinking` + `output_config` + `max_tokens`) for adaptive models |
| Effort maps for 2 models | Extended to all four (5-tier for 4.8/4.7, 4-tier for 4.6/sonnet-4.6) |
| Add native `reasoningContent` response parsing | Not required — responses are simple `{"content"}`; existing parser suffices |
| (no envState / agentContinuationId / header parity) | Add `userInputMessageContext.envState`, `agentContinuationId`; drop `agentMode`; update UA + optout |
| Keep legacy thinking as fallback | No fallback; legacy extended-thinking fully removed |
