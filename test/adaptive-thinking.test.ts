import { afterEach, describe, expect, it } from "vitest";
import {
  ADAPTIVE_PAYLOAD_LOCATIONS,
  buildKiroAdaptiveThinkingPayload,
  getAdaptiveFieldSet,
  getAdaptivePayloadShape,
  isAdaptiveThinkingEnabled,
  isAdaptiveThinkingSupported,
  mapOmpEffortToKiroEffort,
} from "../src/adaptive-thinking.js";
import { applyAdaptivePayloadShape } from "../src/stream.js";

describe("adaptive-thinking", () => {
  afterEach(() => {
    delete process.env.KIRO_ADAPTIVE_THINKING;
    delete process.env.KIRO_ADAPTIVE_PAYLOAD_SHAPE;
    delete process.env.KIRO_ADAPTIVE_FIELDS;
  });

  describe("isAdaptiveThinkingSupported", () => {
    it("returns true for the 5 adaptive models", () => {
      expect(isAdaptiveThinkingSupported("claude-opus-4-8")).toBe(true);
      expect(isAdaptiveThinkingSupported("claude-opus-4-7")).toBe(true);
      expect(isAdaptiveThinkingSupported("claude-opus-4-6")).toBe(true);
      expect(isAdaptiveThinkingSupported("claude-sonnet-5")).toBe(true);
      expect(isAdaptiveThinkingSupported("claude-sonnet-4-6")).toBe(true);
    });
    it("returns false for non-adaptive models", () => {
      expect(isAdaptiveThinkingSupported("claude-haiku-4-5")).toBe(false);
      expect(isAdaptiveThinkingSupported("auto")).toBe(false);
      expect(isAdaptiveThinkingSupported("claude-opus-4-5")).toBe(false);
      expect(isAdaptiveThinkingSupported("qwen3-coder-next")).toBe(false);
    });
  });

  describe("isAdaptiveThinkingEnabled — enabled by default", () => {
    it("is enabled by default", () => {
      expect(isAdaptiveThinkingEnabled()).toBe(true);
    });
    it("is disabled only for '0' or 'false'", () => {
      process.env.KIRO_ADAPTIVE_THINKING = "0";
      expect(isAdaptiveThinkingEnabled()).toBe(false);
      process.env.KIRO_ADAPTIVE_THINKING = "false";
      expect(isAdaptiveThinkingEnabled()).toBe(false);
      process.env.KIRO_ADAPTIVE_THINKING = "1";
      expect(isAdaptiveThinkingEnabled()).toBe(true);
    });
  });

  describe("getAdaptivePayloadShape", () => {
    it("defaults to top-level-wrapper", () => {
      expect(getAdaptivePayloadShape()).toBe("top-level-wrapper");
    });
    it.each(["top-level-wrapper", "top-level-direct", "user-input-message", "user-input-context"] as const)(
      "passes through valid shape %s",
      (shape) => {
        process.env.KIRO_ADAPTIVE_PAYLOAD_SHAPE = shape;
        expect(getAdaptivePayloadShape()).toBe(shape);
      },
    );
    it("falls back to default for unknown shape", () => {
      process.env.KIRO_ADAPTIVE_PAYLOAD_SHAPE = "nonsense";
      expect(getAdaptivePayloadShape()).toBe("top-level-wrapper");
    });
  });

  describe("getAdaptiveFieldSet", () => {
    it("defaults to full", () => {
      expect(getAdaptiveFieldSet()).toBe("full");
    });
    it("returns effort-only only when explicitly set", () => {
      process.env.KIRO_ADAPTIVE_FIELDS = "effort-only";
      expect(getAdaptiveFieldSet()).toBe("effort-only");
    });
  });

  it("ADAPTIVE_PAYLOAD_LOCATIONS covers all four shapes", () => {
    expect(Object.keys(ADAPTIVE_PAYLOAD_LOCATIONS).sort()).toEqual(
      ["top-level-direct", "top-level-wrapper", "user-input-context", "user-input-message"].sort(),
    );
  });

  describe("mapOmpEffortToKiroEffort — opus-4.8 (wire-exact 5-tier)", () => {
    it.each([
      ["minimal", "low"],
      ["low", "low"],
      ["medium", "medium"],
      ["high", "high"],
      ["xhigh", "xhigh"],
      ["max", "max"],
    ] as const)("OMP %s → Kiro %s", (omp, kiro) => {
      expect(mapOmpEffortToKiroEffort("claude-opus-4-8", omp)).toBe(kiro);
    });
  });

  describe("mapOmpEffortToKiroEffort — opus-4.7 (wire-exact 5-tier)", () => {
    it.each([
      ["minimal", "low"],
      ["low", "low"],
      ["medium", "medium"],
      ["high", "high"],
      ["xhigh", "xhigh"],
      ["max", "max"],
    ] as const)("OMP %s → Kiro %s", (omp, kiro) => {
      expect(mapOmpEffortToKiroEffort("claude-opus-4-7", omp)).toBe(kiro);
    });
  });

  describe("mapOmpEffortToKiroEffort — opus-4.6 (wire-exact 4-tier)", () => {
    it.each([
      ["minimal", "low"],
      ["low", "low"],
      ["medium", "medium"],
      ["high", "high"],
      ["xhigh", "max"],
      ["max", "max"],
    ] as const)("OMP %s → Kiro %s", (omp, kiro) => {
      expect(mapOmpEffortToKiroEffort("claude-opus-4-6", omp)).toBe(kiro);
    });
  });

  describe("mapOmpEffortToKiroEffort — sonnet-4.6 (wire-exact 4-tier)", () => {
    it.each([
      ["minimal", "low"],
      ["low", "low"],
      ["medium", "medium"],
      ["high", "high"],
      ["xhigh", "max"],
      ["max", "max"],
    ] as const)("OMP %s → Kiro %s", (omp, kiro) => {
      expect(mapOmpEffortToKiroEffort("claude-sonnet-4-6", omp)).toBe(kiro);
    });
  });

  describe("mapOmpEffortToKiroEffort — sonnet-5 (wire-exact 5-tier)", () => {
    it.each([
      ["minimal", "low"],
      ["low", "low"],
      ["medium", "medium"],
      ["high", "high"],
      ["xhigh", "xhigh"],
      ["max", "max"],
    ] as const)("OMP %s → Kiro %s", (omp, kiro) => {
      expect(mapOmpEffortToKiroEffort("claude-sonnet-5", omp)).toBe(kiro);
    });
  });

  it("mapOmpEffortToKiroEffort returns undefined for non-adaptive model", () => {
    expect(mapOmpEffortToKiroEffort("claude-haiku-4-5", "high")).toBeUndefined();
    expect(mapOmpEffortToKiroEffort("auto", "max")).toBeUndefined();
  });

  describe("buildKiroAdaptiveThinkingPayload", () => {
    it("returns the full payload by default (enabled, full field-set)", () => {
      expect(buildKiroAdaptiveThinkingPayload("claude-opus-4-8", "max")).toEqual({
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "max" },
        max_tokens: 128000,
      });
    });

    it("KIRO_ADAPTIVE_THINKING=0 disables it (returns undefined)", () => {
      process.env.KIRO_ADAPTIVE_THINKING = "0";
      expect(buildKiroAdaptiveThinkingPayload("claude-opus-4-8", "max")).toBeUndefined();
    });

    it("effort-only field-set emits only output_config", () => {
      process.env.KIRO_ADAPTIVE_FIELDS = "effort-only";
      expect(buildKiroAdaptiveThinkingPayload("claude-opus-4-8", "max")).toEqual({
        output_config: { effort: "max" },
      });
    });

    it("full field-set on sonnet-4.6 caps max_tokens at 64000", () => {
      expect(buildKiroAdaptiveThinkingPayload("claude-sonnet-4-6", "max")).toEqual({
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "max" },
        max_tokens: 64000,
      });
    });

    it("sonnet-5 full payload is wire-exact (medium → medium)", () => {
      expect(buildKiroAdaptiveThinkingPayload("claude-sonnet-5", "medium")).toEqual({
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "medium" },
        max_tokens: 128000,
      });
    });

    it("sonnet-5 full payload is wire-exact (high → high)", () => {
      expect(buildKiroAdaptiveThinkingPayload("claude-sonnet-5", "high")).toEqual({
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
        max_tokens: 128000,
      });
    });

    it("sonnet-5 uses model default effort (medium) when effort is undefined", () => {
      expect(buildKiroAdaptiveThinkingPayload("claude-sonnet-5", undefined)?.output_config.effort).toBe("medium");
    });

    it("uses model default effort when reasoning is undefined (opus-4.8 → medium)", () => {
      expect(buildKiroAdaptiveThinkingPayload("claude-opus-4-8", undefined)?.output_config.effort).toBe("medium");
    });

    it("returns undefined for non-adaptive models", () => {
      expect(buildKiroAdaptiveThinkingPayload("claude-haiku-4-5", "high")).toBeUndefined();
      expect(buildKiroAdaptiveThinkingPayload("auto", "max")).toBeUndefined();
      expect(buildKiroAdaptiveThinkingPayload("qwen3-coder-next", "high")).toBeUndefined();
    });
  });
  describe("M3 — payload matches kiro-cli default (top-level shape)", () => {
    it("effort-only field-set at top level is byte-compatible with kiro-cli 2.11.1", () => {
      // kiro-cli 2.11.1 sends `{ output_config: { effort } }` as the
      // `additionalModelRequestFields` sibling of `conversationState`.
      process.env.KIRO_ADAPTIVE_FIELDS = "effort-only";
      const payload = buildKiroAdaptiveThinkingPayload("claude-opus-4-8", "max");
      expect(payload).toEqual({ output_config: { effort: "max" } });
      // The request shape produced by applyAdaptivePayloadShape must match:
      const request: Record<string, unknown> = {
        conversationState: { currentMessage: { userInputMessage: {} } },
      };
      applyAdaptivePayloadShape(request, payload as never, "top-level-wrapper");
      expect(request.additionalModelRequestFields).toEqual({ output_config: { effort: "max" } });
      expect(request.conversationState).toBeDefined();
    });

    it("full field-set at top level is also valid (extension default)", () => {
      const payload = buildKiroAdaptiveThinkingPayload("claude-opus-4-8", "max");
      expect(payload).toEqual({
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "max" },
        max_tokens: 128000,
      });
      const request: Record<string, unknown> = {
        conversationState: { currentMessage: { userInputMessage: {} } },
      };
      applyAdaptivePayloadShape(request, payload as never, "top-level-wrapper");
      expect(request.additionalModelRequestFields).toEqual(payload);
    });
  });
});
