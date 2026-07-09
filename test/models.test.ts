import { describe, expect, it } from "vitest";
import { endpointForApiRegion, extractRegionFromEndpoint, extractRegionFromProfileArn, filterModelsByRegion, KIRO_MODEL_IDS, kiroModels, resolveApiRegion, resolveKiroModel } from "../src/models.js";

describe("Feature 2: Model Definitions", () => {
  describe("resolveKiroModel", () => {
    it.each([
      // Claude models - dash to dot conversion
      ["claude-opus-4-8", "claude-opus-4.8"],
      ["claude-opus-4-7", "claude-opus-4.7"],
      ["claude-opus-4-6", "claude-opus-4.6"],
      ["claude-sonnet-5", "claude-sonnet-5"],
      ["claude-sonnet-4-6", "claude-sonnet-4.6"],
      ["claude-sonnet-4-5", "claude-sonnet-4.5"],
      ["claude-sonnet-4", "claude-sonnet-4"],
      ["claude-haiku-4-5", "claude-haiku-4.5"],
      // Non-Claude models
      ["deepseek-3-2", "deepseek-3.2"],
      ["minimax-m2-1", "minimax-m2.1"],
      ["glm-5", "glm-5"],
      ["qwen3-coder-next", "qwen3-coder-next"],
    ])("maps %s → %s", (piId, kiroId) => {
      expect(resolveKiroModel(piId)).toBe(kiroId);
    });

    it("throws on unknown model ID", () => {
      expect(() => resolveKiroModel("nonexistent")).toThrow("Unknown Kiro model ID");
    });
  });

  describe("KIRO_MODEL_IDS", () => {
    it("contains 14 model IDs", () => {
      expect(KIRO_MODEL_IDS.size).toBe(14);
    });
  });

  describe("resolveApiRegion", () => {
    it("maps us-east-2 to us-east-1", () => {
      expect(resolveApiRegion("us-east-2")).toBe("us-east-1");
    });

    it("maps eu-west-1 to eu-central-1", () => {
      expect(resolveApiRegion("eu-west-1")).toBe("eu-central-1");
    });

    it("maps ap-southeast-2 to us-east-1", () => {
      expect(resolveApiRegion("ap-southeast-2")).toBe("us-east-1");
    });

    it("passes through us-east-1 unchanged", () => {
      expect(resolveApiRegion("us-east-1")).toBe("us-east-1");
    });

    it("defaults to us-east-1 when undefined", () => {
      expect(resolveApiRegion(undefined)).toBe("us-east-1");
    });
  });

  describe("filterModelsByRegion", () => {
    it("us-east-1 returns all models", () => {
      expect(filterModelsByRegion(kiroModels, "us-east-1")).toHaveLength(kiroModels.length);
    });

    it("eu-central-1 includes Claude + documented OSS, excludes DeepSeek and undocumented models", () => {
      const ids = filterModelsByRegion(kiroModels, "eu-central-1").map((m) => m.id);
      expect(ids).toContain("claude-sonnet-5");
      expect(ids).toContain("claude-sonnet-4-6");
      expect(ids).toContain("minimax-m2-1");
      expect(ids).not.toContain("deepseek-3-2");
      expect(ids).not.toContain("agi-nova-beta-1m");
    });

    it("unknown region returns no models", () => {
      expect(filterModelsByRegion(kiroModels, "af-south-1")).toHaveLength(0);
    });
  });

  describe("model catalog", () => {
    it("defines 14 models", () => {
      expect(kiroModels).toHaveLength(14);
    });

    it("claude-haiku-4-5 has reasoning=false", () => {
      expect(kiroModels.find((m) => m.id === "claude-haiku-4-5")?.reasoning).toBe(false);
    });

    it("flash models have reasoning=false", () => {
      const flashModels = kiroModels.filter((m) => m.id.includes("flash"));
      expect(flashModels.every((m) => m.reasoning === false)).toBe(true);
    });

    it("minimax has reasoning=false", () => {
      expect(kiroModels.find((m) => m.id === "minimax-m2-1")?.reasoning).toBe(false);
    });

    it("Claude models support text and image input", () => {
      const claudeModels = kiroModels.filter((m) => m.id.startsWith("claude-"));
      expect(claudeModels.every((m) => m.input.includes("text") && m.input.includes("image"))).toBe(true);
    });

    it("non-Claude models (except auto) support text only", () => {
      const textOnlyModels = kiroModels.filter((m) => !m.id.startsWith("claude-") && m.id !== "auto");
      expect(textOnlyModels.every((m) => m.input.includes("text") && !m.input.includes("image"))).toBe(true);
    });

    it("all models have zero cost", () => {
      expect(kiroModels.every((m) => m.cost.input === 0 && m.cost.output === 0)).toBe(true);
    });

    it("opus models have expected max tokens", () => {
      const opusModels = kiroModels.filter((m) => m.id.includes("opus"));
      expect(opusModels.every((m) => m.maxTokens === 32768 || m.maxTokens === 128000)).toBe(true);
    });

    it("non-Claude models (except auto) have 8K max tokens", () => {
      const nonClaudeModels = kiroModels.filter((m) => !m.id.startsWith("claude-") && m.id !== "auto");
      expect(nonClaudeModels.every((m) => m.maxTokens === 8192)).toBe(true);
    });
  });

  // The five adaptive models carry `thinking: ThinkingConfig` (anthropic-adaptive).
  // All other models must NOT carry adaptive thinking metadata.
  describe("adaptive thinking metadata", () => {
    const ADAPTIVE = ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-4-6"];

    it("the five adaptive models have anthropic-adaptive thinking metadata", () => {
      for (const m of kiroModels.filter((x) => ADAPTIVE.includes(x.id))) {
        const t = (m as { thinking?: { mode?: string; efforts?: readonly string[]; effortMap?: Record<string, string>; supportsDisplay?: boolean } }).thinking;
        expect(t, `${m.id} thinking`).toBeDefined();
        expect(t?.mode).toBe("anthropic-adaptive");
        expect(t?.supportsDisplay).toBe(true);
        expect(t?.efforts).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
        expect(t?.effortMap?.xhigh).toBe("max");
      }
    });

    it("opus 4.8/4.7 use the 5-tier map (medium → high)", () => {
      for (const id of ["claude-opus-4-8", "claude-opus-4-7"]) {
        const m = kiroModels.find((x) => x.id === id) as { thinking?: { effortMap?: Record<string, string> } };
        expect(m.thinking?.effortMap?.medium).toBe("high");
        expect(m.thinking?.effortMap?.high).toBe("xhigh");
      }
    });

    it("opus 4.6 / sonnet 4.6 use the 4-tier map (high → high)", () => {
      for (const id of ["claude-opus-4-6", "claude-sonnet-4-6"]) {
        const m = kiroModels.find((x) => x.id === id) as { thinking?: { effortMap?: Record<string, string> } };
        expect(m.thinking?.effortMap?.high).toBe("high");
        expect(m.thinking?.effortMap?.low).toBe("low");
      }
    });

    it("non-adaptive models have no thinking metadata", () => {
      for (const m of kiroModels.filter((x) => !ADAPTIVE.includes(x.id))) {
        expect((m as { thinking?: unknown }).thinking, `${m.id} thinking`).toBeUndefined();
      }
    });

    it("no model retains the dead thinkingLevelMap field", () => {
      for (const m of kiroModels) {
        expect((m as { thinkingLevelMap?: unknown }).thinkingLevelMap, `${m.id}`).toBeUndefined();
      }
    });
  });

  describe("endpointForApiRegion", () => {
    it("constructs correct endpoint", () => {
      expect(endpointForApiRegion("eu-central-1")).toBe("https://runtime.eu-central-1.kiro.dev/");
      expect(endpointForApiRegion("us-east-1")).toBe("https://runtime.us-east-1.kiro.dev/");
    });
  });

  describe("extractRegionFromEndpoint", () => {
    it("extracts region from valid endpoint", () => {
      expect(extractRegionFromEndpoint("https://runtime.us-east-1.kiro.dev/")).toBe("us-east-1");
      expect(extractRegionFromEndpoint("https://runtime.eu-central-1.kiro.dev/")).toBe("eu-central-1");
      // legacy q.amazonaws.com format still resolves (cached auth-meta)
      expect(extractRegionFromEndpoint("https://q.us-east-1.amazonaws.com/generateAssistantResponse")).toBe("us-east-1");
      expect(extractRegionFromEndpoint("https://q.eu-central-1.amazonaws.com/generateAssistantResponse")).toBe("eu-central-1");
    });
    it("returns undefined for invalid input", () => {
      expect(extractRegionFromEndpoint(undefined)).toBeUndefined();
      expect(extractRegionFromEndpoint("not-a-url")).toBeUndefined();
    });
  });

  describe("extractRegionFromProfileArn", () => {
    it("extracts region from valid profile ARN", () => {
      expect(extractRegionFromProfileArn("arn:aws:codewhisperer:eu-central-1:123:profile/abc")).toBe("eu-central-1");
      expect(extractRegionFromProfileArn("arn:aws:codewhisperer:us-east-1:456:profile/def")).toBe("us-east-1");
    });
    it("returns undefined for invalid input", () => {
      expect(extractRegionFromProfileArn(undefined)).toBeUndefined();
      expect(extractRegionFromProfileArn("not-an-arn")).toBeUndefined();
      expect(extractRegionFromProfileArn("")).toBeUndefined();
    });
  });
});
