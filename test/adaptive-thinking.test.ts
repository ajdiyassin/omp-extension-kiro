// ABOUTME: Tests metadata-driven Kiro request fields for Anthropic and GPT models.
// ABOUTME: Verifies effort mapping, defaults, kill-switch behavior, and payload locations.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADAPTIVE_PAYLOAD_LOCATIONS,
  buildKiroModelRequestFields,
  getAdaptiveFieldSet,
  getAdaptivePayloadShape,
  isAdaptiveThinkingEnabled,
} from "../src/adaptive-thinking.js";
import { mapKiroModelCatalog } from "../src/model-discovery.js";
import type { SanitizedListAvailableModelsResponse } from "../src/model-discovery-fixture.js";
import { applyAdaptivePayloadShape } from "../src/stream.js";

const fixture = JSON.parse(
  readFileSync("test/fixtures/kiro-list-available-models-2.13.1.json", "utf-8"),
) as SanitizedListAvailableModelsResponse;
const models = mapKiroModelCatalog(fixture);

function model(id: string) {
  const found = models.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`fixture model missing: ${id}`);
  return found;
}

afterEach(() => {
  delete process.env.KIRO_ADAPTIVE_THINKING;
  delete process.env.KIRO_ADAPTIVE_PAYLOAD_SHAPE;
  delete process.env.KIRO_ADAPTIVE_FIELDS;
});

describe("metadata-driven Kiro request fields", () => {
  it("builds Sonnet 5 adaptive fields with its 128K combined ceiling", () => {
    expect(buildKiroModelRequestFields(model("claude-sonnet-5"), "max")).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "max" },
      max_tokens: 128000,
    });
  });

  it("uses the live schema default when OMP supplies no effort", () => {
    expect(buildKiroModelRequestFields(model("claude-sonnet-5"), undefined)).toMatchObject({
      output_config: { effort: "high" },
    });
    expect(buildKiroModelRequestFields(model("claude-opus-4.7"), undefined)).toMatchObject({
      output_config: { effort: "xhigh" },
    });
  });

  it("maps OMP minimal to the lowest Anthropic wire effort", () => {
    expect(buildKiroModelRequestFields(model("claude-opus-4.8"), "minimal")).toMatchObject({
      output_config: { effort: "low" },
    });
  });

  it("clamps unsupported xhigh upward on a four-tier adaptive model", () => {
    expect(buildKiroModelRequestFields(model("claude-opus-4.6"), "xhigh")).toMatchObject({
      output_config: { effort: "max" },
      max_tokens: 64000,
    });
  });

  it("builds GPT standard reasoning fields and maps minimal to none", () => {
    expect(buildKiroModelRequestFields(model("gpt-5.6-sol"), "minimal")).toEqual({
      reasoning: { mode: "standard", effort: "none" },
    });
    expect(buildKiroModelRequestFields(model("gpt-5.6-sol"), undefined)).toEqual({
      reasoning: { mode: "standard", effort: "high" },
    });
  });

  it("returns undefined for schema-less models", () => {
    expect(buildKiroModelRequestFields(model("claude-haiku-4.5"), "high")).toBeUndefined();
    expect(buildKiroModelRequestFields(model("auto"), "max")).toBeUndefined();
  });

  it("the adaptive kill-switch disables Claude fields but not GPT reasoning", () => {
    process.env.KIRO_ADAPTIVE_THINKING = "0";
    expect(isAdaptiveThinkingEnabled()).toBe(false);
    expect(buildKiroModelRequestFields(model("claude-sonnet-5"), "high")).toBeUndefined();
    expect(buildKiroModelRequestFields(model("gpt-5.6-sol"), "high")).toEqual({
      reasoning: { mode: "standard", effort: "high" },
    });
  });

  it("supports the legacy effort-only Claude field set", () => {
    process.env.KIRO_ADAPTIVE_FIELDS = "effort-only";
    expect(getAdaptiveFieldSet()).toBe("effort-only");
    expect(buildKiroModelRequestFields(model("claude-sonnet-5"), "medium")).toEqual({
      output_config: { effort: "medium" },
    });
  });
});

describe("request field payload locations", () => {
  it("defaults to the top-level additionalModelRequestFields wrapper", () => {
    expect(getAdaptivePayloadShape()).toBe("top-level-wrapper");
    expect(ADAPTIVE_PAYLOAD_LOCATIONS["top-level-wrapper"]).toBe("request.additionalModelRequestFields");
  });

  it.each([
    "top-level-wrapper",
    "top-level-direct",
    "user-input-message",
    "user-input-context",
  ] as const)("accepts %s", (shape) => {
    process.env.KIRO_ADAPTIVE_PAYLOAD_SHAPE = shape;
    expect(getAdaptivePayloadShape()).toBe(shape);
  });

  it("places Anthropic fields in the top-level wrapper", () => {
    const payload = buildKiroModelRequestFields(model("claude-sonnet-5"), "high");
    const request: Record<string, unknown> = {
      conversationState: { currentMessage: { userInputMessage: {} } },
    };
    applyAdaptivePayloadShape(request as never, payload as never, "top-level-wrapper");
    expect(request.additionalModelRequestFields).toEqual(payload);
  });

  it("spreads GPT reasoning in the direct experimental shape", () => {
    const payload = buildKiroModelRequestFields(model("gpt-5.6-sol"), "xhigh");
    const request: Record<string, unknown> = {
      conversationState: { currentMessage: { userInputMessage: {} } },
    };
    applyAdaptivePayloadShape(request as never, payload as never, "top-level-direct");
    expect(request.reasoning).toEqual({ mode: "standard", effort: "xhigh" });
  });
});
