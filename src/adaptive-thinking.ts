// ABOUTME: Adaptive-thinking mapper + experiment harness for the Kiro API.
// ABOUTME: Builds the additionalModelRequestFields payload per model + OMP effort level.
//
// VALIDATED (2026-06-12, live runtime, claude-sonnet-4.6): the top-level
// additionalModelRequestFields block — both {output_config} and the full
// {thinking,output_config,max_tokens} — returns 200 and streams real content.
// The earlier 400 REQUEST_BODY_INVALID was NOT the adaptive payload; it was
// envState.operatingSystem being sent as "win32" instead of "windows" (fixed in
// transform.ts). Adaptive thinking is therefore ENABLED by default, with the
// full payload at the top level (matches the advertised per-model schema).
//
// Env overrides (kill-switch + debugging — all four shapes/field-sets were live-verified):
//   KIRO_ADAPTIVE_THINKING=0|false     disable entirely (default: enabled)
//   KIRO_ADAPTIVE_PAYLOAD_SHAPE=...     payload location (default top-level-wrapper)
//       top-level-wrapper   -> { ...request, additionalModelRequestFields: payload }
//       top-level-direct     -> { ...request, ...payload }  (siblings of conversationState)
//       user-input-message   -> currentMessage.userInputMessage.additionalModelRequestFields
//       user-input-context   -> currentMessage.userInputMessage.userInputMessageContext.additionalModelRequestFields
//   KIRO_ADAPTIVE_FIELDS=full|effort-only   which fields to send (default full)
//       full         -> { thinking, output_config, max_tokens }  (advertised schema, future-proof)
//       effort-only -> { output_config: { effort } }            (minimal; what kiro-cli sends by default)

// MIGRATION DECISION (2026-07-08, kiro-cli 2.11.1): kiro-cli defaults to the
// `effort-only` field-set (output_config.effort) at the top level, but the
// extension defaults to `full` ({ thinking, output_config, max_tokens }). Both
// are live-verified 200-OK against the Kiro runtime. We KEEP `full` as the
// default because it mirrors the advertised per-model schema and is
// future-proof (e.g., if `thinking` or `max_tokens` become required). The
// `effort-only` shape can be opted into via KIRO_ADAPTIVE_FIELDS=effort-only to
// mirror kiro-cli exactly. See docs/kiro-cli-latest-migration-handoff.md M3.

export type OmpEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type KiroEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type KiroAdaptivePayload = {
  thinking?: { type: "adaptive"; display: "summarized" };
  output_config: { effort: KiroEffort };
  max_tokens?: number;
};

export type AdaptivePayloadShape =
  | "top-level-wrapper"
  | "top-level-direct"
  | "user-input-message"
  | "user-input-context";

export type AdaptiveFieldSet = "full" | "effort-only";

type ModelConfig = {
  kiroModelId: string;
  maxTokens: number;
  defaultOmpEffort: OmpEffort;
  effortMap: Record<OmpEffort, KiroEffort>;
};

const FIVE_TIER: Record<OmpEffort, KiroEffort> = {
  minimal: "low",
  low: "medium",
  medium: "high",
  high: "xhigh",
  xhigh: "max",
};

const FOUR_TIER: Record<OmpEffort, KiroEffort> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
};

const KIRO_ADAPTIVE_MODELS: Record<string, ModelConfig> = {
  "claude-opus-4-8": { kiroModelId: "claude-opus-4.8", maxTokens: 128000, defaultOmpEffort: "medium", effortMap: FIVE_TIER },
  "claude-opus-4-7": { kiroModelId: "claude-opus-4.7", maxTokens: 128000, defaultOmpEffort: "high",   effortMap: FIVE_TIER },
  "claude-opus-4-6": { kiroModelId: "claude-opus-4.6", maxTokens: 64000,  defaultOmpEffort: "high",   effortMap: FOUR_TIER },
  "claude-sonnet-4-6": { kiroModelId: "claude-sonnet-4.6", maxTokens: 64000, defaultOmpEffort: "high", effortMap: FOUR_TIER },
};

const PAYLOAD_SHAPES: readonly AdaptivePayloadShape[] = [
  "top-level-wrapper",
  "top-level-direct",
  "user-input-message",
  "user-input-context",
];

/** Human-readable JSON path each shape writes to — surfaced as `adaptivePayloadLocation` in debug logs. */
export const ADAPTIVE_PAYLOAD_LOCATIONS: Record<AdaptivePayloadShape, string> = {
  "top-level-wrapper": "request.additionalModelRequestFields",
  "top-level-direct": "request.{thinking,output_config,max_tokens}",
  "user-input-message": "conversationState.currentMessage.userInputMessage.additionalModelRequestFields",
  "user-input-context":
    "conversationState.currentMessage.userInputMessage.userInputMessageContext.additionalModelRequestFields",
};

export function isAdaptiveThinkingSupported(modelId: string): boolean {
  return Object.hasOwn(KIRO_ADAPTIVE_MODELS, modelId);
}

/** Adaptive thinking is enabled by default; KIRO_ADAPTIVE_THINKING=0 is the kill-switch. */
export function isAdaptiveThinkingEnabled(): boolean {
  const v = process.env.KIRO_ADAPTIVE_THINKING;
  return v !== "0" && v !== "false";
}

/** Where to place the adaptive payload in the request (experiment knob). */
export function getAdaptivePayloadShape(): AdaptivePayloadShape {
  const v = process.env.KIRO_ADAPTIVE_PAYLOAD_SHAPE as AdaptivePayloadShape | undefined;
  return v && PAYLOAD_SHAPES.includes(v) ? v : "top-level-wrapper";
}

/** Which fields to include in the adaptive payload (default full; effort-only is the minimal kiro-cli shape). */
export function getAdaptiveFieldSet(): AdaptiveFieldSet {
  return process.env.KIRO_ADAPTIVE_FIELDS === "effort-only" ? "effort-only" : "full";
}

export function mapOmpEffortToKiroEffort(modelId: string, effort: OmpEffort | undefined): KiroEffort | undefined {
  const cfg = KIRO_ADAPTIVE_MODELS[modelId];
  if (!cfg) return undefined;
  return cfg.effortMap[effort ?? cfg.defaultOmpEffort];
}

/**
 * Build the adaptive-thinking payload for a model + OMP effort, honoring the
 * opt-in flag and the field-set knob. Returns undefined when adaptive thinking
 * is disabled (default), the model is not adaptive, or no effort can be mapped.
 */
export function buildKiroAdaptiveThinkingPayload(
  modelId: string,
  ompEffort: OmpEffort | undefined,
): KiroAdaptivePayload | undefined {
  if (!isAdaptiveThinkingEnabled()) return undefined;
  const cfg = KIRO_ADAPTIVE_MODELS[modelId];
  if (!cfg) return undefined;
  const effort = cfg.effortMap[ompEffort ?? cfg.defaultOmpEffort];
  if (getAdaptiveFieldSet() === "effort-only") {
    return { output_config: { effort } };
  }
  return {
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort },
    max_tokens: cfg.maxTokens,
  };
}
