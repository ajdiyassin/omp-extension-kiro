// ABOUTME: Builds Kiro additionalModelRequestFields from OMP canonical thinking metadata.
// ABOUTME: Supports Anthropic adaptive and GPT reasoning schema families without model-ID tables.

import type { Api, Model } from "@oh-my-pi/pi-ai";

export type OmpEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type KiroAnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type KiroGptEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type KiroAnthropicRequestFields = {
  thinking?: { type: "adaptive"; display: "summarized" };
  output_config: { effort: KiroAnthropicEffort };
  max_tokens?: number;
};

export type KiroGptRequestFields = {
  reasoning: {
    mode: "standard";
    effort: KiroGptEffort;
  };
};

export type KiroModelRequestFields = KiroAnthropicRequestFields | KiroGptRequestFields;

export type AdaptivePayloadShape =
  | "top-level-wrapper"
  | "top-level-direct"
  | "user-input-message"
  | "user-input-context";

export type AdaptiveFieldSet = "full" | "effort-only";

const OMP_EFFORT_ORDER: readonly OmpEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const PAYLOAD_SHAPES: readonly AdaptivePayloadShape[] = [
  "top-level-wrapper",
  "top-level-direct",
  "user-input-message",
  "user-input-context",
];

/** Human-readable JSON path each shape writes to, surfaced in debug logs. */
export const ADAPTIVE_PAYLOAD_LOCATIONS: Record<AdaptivePayloadShape, string> = {
  "top-level-wrapper": "request.additionalModelRequestFields",
  "top-level-direct": "request.{thinking,output_config,max_tokens,reasoning}",
  "user-input-message": "conversationState.currentMessage.userInputMessage.additionalModelRequestFields",
  "user-input-context":
    "conversationState.currentMessage.userInputMessage.userInputMessageContext.additionalModelRequestFields",
};

/** Adaptive thinking is enabled by default; KIRO_ADAPTIVE_THINKING=0 is the Claude kill-switch. */
export function isAdaptiveThinkingEnabled(): boolean {
  const value = process.env.KIRO_ADAPTIVE_THINKING;
  return value !== "0" && value !== "false";
}

export function getAdaptivePayloadShape(): AdaptivePayloadShape {
  const value = process.env.KIRO_ADAPTIVE_PAYLOAD_SHAPE as AdaptivePayloadShape | undefined;
  return value && PAYLOAD_SHAPES.includes(value) ? value : "top-level-wrapper";
}

export function getAdaptiveFieldSet(): AdaptiveFieldSet {
  return process.env.KIRO_ADAPTIVE_FIELDS === "effort-only" ? "effort-only" : "full";
}

function mapEffort(model: Pick<Model<Api>, "thinking">, requested: OmpEffort | undefined): string | undefined {
  const thinking = model.thinking;
  if (!thinking || thinking.efforts.length === 0) return undefined;
  const defaultEffort = thinking.defaultLevel as OmpEffort | undefined;
  const selected = requested ?? defaultEffort ?? "medium";
  const mapped = thinking.effortMap?.[selected];
  if (mapped) return mapped;
  if ((thinking.efforts as readonly string[]).includes(selected)) return selected;

  const selectedIndex = OMP_EFFORT_ORDER.indexOf(selected);
  const supported = thinking.efforts as readonly OmpEffort[];
  for (let index = Math.max(selectedIndex, 0); index < OMP_EFFORT_ORDER.length; index += 1) {
    const candidate = OMP_EFFORT_ORDER[index];
    if (supported.includes(candidate)) return thinking.effortMap?.[candidate] ?? candidate;
  }
  const highest = supported.at(-1);
  return highest ? (thinking.effortMap?.[highest] ?? highest) : undefined;
}

/** Build provider-specific request fields from metadata that survives OMP's SQLite model cache. */
export function buildKiroModelRequestFields(
  model: Pick<Model<Api>, "thinking" | "maxTokens">,
  ompEffort: OmpEffort | undefined,
): KiroModelRequestFields | undefined {
  if (!model.thinking) return undefined;
  const effort = mapEffort(model, ompEffort);
  if (!effort) return undefined;

  if (model.thinking.mode === "anthropic-adaptive") {
    if (!isAdaptiveThinkingEnabled()) return undefined;
    const output_config = { effort: effort as KiroAnthropicEffort };
    if (getAdaptiveFieldSet() === "effort-only") return { output_config };
    return {
      thinking: { type: "adaptive", display: "summarized" },
      output_config,
      max_tokens: model.maxTokens ?? undefined,
    };
  }

  if (model.thinking.mode === "effort") {
    return {
      reasoning: {
        mode: "standard",
        effort: effort as KiroGptEffort,
      },
    };
  }

  return undefined;
}
