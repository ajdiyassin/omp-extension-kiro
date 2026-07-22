# Claude effort, adaptive thinking, and Kiro Sonnet 5 limits

Research date: 2026-07-22. Scope is limited to the three official pages below and the repository's sanitized Kiro CLI 2.13.1 `ListAvailableModels` fixture.

## Sources

- Anthropic, [Effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- Anthropic, [Adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)
- Kiro, [Models](https://kiro.dev/docs/models/)
- Local first-party API capture: [`test/fixtures/kiro-list-available-models-2.13.1.json`](../test/fixtures/kiro-list-available-models-2.13.1.json), captured from `ListAvailableModels` in `us-east-1` using Kiro CLI 2.13.1 on 2026-07-22

## Conclusions

1. Claude's API effort tiers are `low`, `medium`, `high`, `xhigh`, and `max` where supported. `high` is the API default: Anthropic says setting `high` is “exactly the same behavior as omitting” effort. Effort is behavioral/soft guidance over all response-token use, not a token quota.
2. Sonnet 5 supports all five tiers and defaults to `high`. In adaptive mode, `max` always thinks, `xhigh` always thinks deeply, `high` almost always thinks, and `medium`/`low` may skip thinking on simple requests.
3. Sonnet 5 adaptive thinking is **on by default**. It can be disabled with `thinking: {type: "disabled"}`; manual `type: "enabled"` thinking is rejected. Adaptive thinking enables interleaved thinking between tool calls.
4. `max_tokens` is a hard cap on **total generated output: internal thinking plus response text**. It is not a thinking-only budget, and 128K must not be interpreted as 64K thinking plus 64K visible output.
5. For Kiro Sonnet 5, the fixture advertises `tokenLimits.maxOutputTokens: 64000` but separately validates the request field `max_tokens` through `128000`. The safest implementation interpretation is: **128K is the accepted hard combined request cap for Sonnet 5 adaptive output**, while 64K is conflicting/coarser catalog metadata whose precise enforcement meaning is not documented by the allowed official pages. Do not add the values or promise 128K of visible text.

## Explicit official documentation

### Effort semantics

Anthropic describes effort as controlling how many tokens Claude spends across the whole response, including text, tool calls/function arguments, and extended thinking. It is a “behavioral signal, not a strict token budget.” The tiers are:

| Tier | Official semantics | Sonnet 5 |
|---|---|---|
| `low` | Most efficient; significant token savings with some capability reduction | Supported |
| `medium` | Balanced, moderate token savings | Supported |
| `high` | High capability; equivalent to omitting effort | Supported; **default** |
| `xhigh` | Extended capability for long-horizon work | Supported |
| `max` | Absolute maximum capability, unconstrained behavioral token spending | Supported |

“Unconstrained” at `max` does not remove the request's hard `max_tokens` ceiling. Anthropic explicitly recommends a sufficiently large `max_tokens` at high effort levels.

For Sonnet 5 specifically, Anthropic recommends `high` by default for complex reasoning/coding/agentic work, `xhigh` for the hardest coding and agentic tasks, `medium` as a cost-saving step down, `low` for latency/high-volume work, and `max` for absolute highest capability.

Kiro's UI documentation describes the same five user-facing levels (Low through Max), but its published availability table currently lists configurable effort only for Opus 4.8/4.7/4.6 and Sonnet 4.6—not Sonnet 5. That omission conflicts with both Anthropic's current Sonnet 5 docs and Kiro's own live Sonnet 5 schema in the fixture; it should not be read as proof that Kiro rejects Sonnet 5 effort.

### Adaptive-thinking behavior

Anthropic states that adaptive thinking dynamically decides **whether and how much** to think based on each request. At `high` it almost always thinks; at lower levels it may skip thinking for simple prompts. Its effort behavior is documented as:

- `max`: always thinks, without a depth constraint other than hard output limits.
- `xhigh`: always thinks deeply with extended exploration.
- `high` (default): almost always thinks; deep reasoning on complex tasks.
- `medium`: moderate thinking; may skip simple requests.
- `low`: minimizes thinking; skips it for simple requests.

For Sonnet 5, adaptive thinking is on when `thinking` is omitted, `disabled` explicitly turns it off, and manual `{type: "enabled", budget_tokens: N}` is unsupported (400). Adaptive mode automatically enables interleaved thinking. Sonnet 5's thinking display defaults to `omitted`; setting `display: "summarized"` returns a summary, not raw/full thinking. Display affects visibility/latency, not whether thinking occurs or what is billed.

### What `max_tokens` counts

Anthropic is unambiguous: “Thinking tokens count toward `max_tokens`,” and its cost-control section calls `max_tokens` a “hard limit on total output (thinking + response text).” Tool calls are also response output governed behaviorally by effort. Summarized or omitted thinking can make visible tokens differ from billed/consumed output tokens; `usage.output_tokens` remains inclusive.

Therefore:

```text
thinking tokens + visible response/tool-call tokens <= max_tokens
```

It is **not**:

```text
thinking budget = max_tokens, plus a separate visible-output allowance
```

## Fixture facts

The fixture reports the following Kiro data (facts from the capture, not general claims about all accounts/regions):

| Model | `maxInputTokens` | `maxOutputTokens` | Request-schema `max_tokens.maximum` | Effort enum/default |
|---|---:|---:|---:|---|
| Claude Sonnet 5 | 1,000,000 | 64,000 | 128,000 | low/medium/high/xhigh/max; high |
| Claude Opus 4.8 | 1,000,000 | 128,000 | 128,000 | low/medium/high/xhigh/max; high |
| Claude Opus 4.7 | 1,000,000 | 128,000 | 128,000 | low/medium/high/xhigh/max; **xhigh in Kiro schema** |
| Claude Opus 4.6 | 1,000,000 | 64,000 | 64,000 | low/medium/high/max; high |
| Claude Sonnet 4.6 | 1,000,000 | 64,000 | 64,000 | low/medium/high/max; high |

For Sonnet 5, the schema allows `thinking.type` values `adaptive` and `disabled`, display values `summarized` and `omitted`, and `max_tokens` from 1,024 through 128,000.

The fixture's Opus 4.7 `output_config.effort.default: "xhigh"` is a **Kiro schema default**, whereas Anthropic documents the direct API default as `high` and recommends explicitly choosing `xhigh` for coding/agentic use. Defaults must therefore be identified by layer rather than conflated.

## Reconciling Sonnet 5's 64K and 128K values

### Established facts

- Anthropic defines request `max_tokens` as one combined hard cap for thinking plus response text.
- Kiro's captured Sonnet 5 additional-request schema accepts that field up to 128,000.
- The same model record says `tokenLimits.maxOutputTokens` is 64,000.
- Neither the Kiro Models page nor the two Anthropic pages defines the semantic relationship between those two Kiro fields. Kiro's page documents Sonnet 5's 1M context but gives no Sonnet 5 maximum-output figure. It explicitly states 128K max output only for Opus 4.8.

### Inference for implementation

Treat the nested request schema as the model-specific authority for validating the optional `additionalModelRequestFields.max_tokens`: Sonnet 5 permits a value up to 128K, and that value caps combined thinking plus visible output. Treat `tokenLimits.maxOutputTokens: 64000` as Kiro catalog metadata that may represent a nominal/default client-facing output limit, a coarse legacy field, or another platform limit; the allowed sources do not distinguish among these explanations.

Consequently, an implementation may expose/send a Sonnet 5 combined adaptive-output cap of 128K when using the model-specific request field, but it should document the catalog discrepancy and must not claim that Kiro guarantees 128K of visible response text. A conservative client that does not send the additional `max_tokens` override may continue to use the advertised 64K catalog value.

## Context, output, and Kiro availability

From Kiro's current Models page:

- **Claude Sonnet 5:** 1M context, 1.3x credits, experimental (launched 2026-06-30), available to Pro/Pro+/Pro Max/Power in `us-east-1` and `eu-central-1`, with cross-region inference; unavailable on Free. The page does not publish its max output.
- **Claude Opus 4.8:** 1M context and explicitly 128K max output; active; `us-east-1` and `eu-central-1`; paid tiers.
- **Claude Opus 4.7 / 4.6 and Sonnet 4.6:** 1M context; active; both listed regions; paid tiers. The page does not publish their max output values.
- **Claude Opus 4.5, Sonnet 4.5, Sonnet 4.0, and Haiku 4.5:** 200K context. The fixture reports 64K output for each.

Availability can vary by country/region and account eligibility. The fixture proves that Sonnet 5 was returned for one OAuth-IDC account querying `us-east-1`; it does not establish universal entitlement.

## Spec-facing recommendation

For Sonnet 5, model support should use all five effort values with `high` as the semantic/API default, preserve adaptive-by-default behavior (or explicitly send `adaptive` when Kiro requires a normalized payload), and treat any sent `max_tokens` as a single combined thinking-plus-response ceiling. Use 128,000 as the model-specific request maximum evidenced by Kiro's schema, while retaining an explicit note that Kiro's generic model metadata simultaneously advertises 64,000 and that the official pages do not explain the discrepancy.
