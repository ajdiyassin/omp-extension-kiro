import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertSanitizedFixtureSafe,
  type SanitizedListAvailableModelsResponse,
  sanitizeListAvailableModelsResponse,
} from "../src/model-discovery-fixture.js";

const source = {
  client: "kiro-cli" as const,
  clientVersion: "2.13.1",
  operation: "ListAvailableModels" as const,
  apiRegion: "eu-central-1" as const,
  credentialKind: "oauth-idc" as const,
  capturedAt: "2026-07-22T00:00:00.000Z",
};

function model(overrides: Record<string, unknown> = {}) {
  return {
    modelId: "gpt-5.6-sol",
    modelName: "GPT 5.6 Sol",
    description: "Experimental model",
    supportedInputTypes: ["TEXT", "IMAGE"],
    tokenLimits: { maxInputTokens: 272000, maxOutputTokens: 64000 },
    promptCaching: { supportsPromptCaching: false },
    rateMultiplier: 2.4,
    rateUnit: "Credit",
    ...overrides,
  };
}

function response(modelValue: Record<string, unknown> = model()) {
  return {
    defaultModel: { modelId: modelValue.modelId },
    models: [modelValue],
  };
}

describe("sanitized ListAvailableModels fixture", () => {
  it("preserves dotted IDs and required model metadata", () => {
    const fixture = sanitizeListAvailableModelsResponse(response(), source);
    expect(fixture.models[0]).toMatchObject({
      modelId: "gpt-5.6-sol",
      supportedInputTypes: ["TEXT", "IMAGE"],
      tokenLimits: { maxInputTokens: 272000, maxOutputTokens: 64000 },
      rateMultiplier: 2.4,
      rateUnit: "Credit",
    });
  });

  it("reconstructs an allowlisted adaptive-thinking schema", () => {
    const adaptive = model({
      modelId: "claude-opus-4.8",
      modelName: "Claude Opus 4.8",
      additionalModelRequestFieldsSchema: {
        type: "object",
        properties: {
          thinking: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["adaptive", "disabled"] },
              display: { type: "string", enum: ["summarized", "omitted"] },
            },
            required: ["type"],
          },
          output_config: {
            type: "object",
            properties: {
              effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"], default: "high" },
            },
          },
          max_tokens: { type: "integer", minimum: 1024, maximum: 128000 },
        },
        additionalProperties: false,
      },
    });
    const fixture = sanitizeListAvailableModelsResponse(response(adaptive), source);
    const schema = fixture.models[0]?.additionalModelRequestFieldsSchema;
    expect(schema?.properties?.output_config?.properties?.effort).toEqual({
      type: "string",
      enum: ["low", "medium", "high", "xhigh", "max"],
      default: "high",
    });
    expect(schema?.properties?.max_tokens).toEqual({ type: "integer", minimum: 1024, maximum: 128000 });
  });

  it.each([
    ["unknown top-level field", { ...response(), profileArn: "forbidden" }],
    ["unknown model field", response(model({ owner: "forbidden" }))],
    ["unknown schema keyword", response(model({ additionalModelRequestFieldsSchema: { type: "object", title: "x" } }))],
    ["unknown modality", response(model({ supportedInputTypes: ["TEXT", "AUDIO"] }))],
    ["identity-bearing text", response(model({ description: "contact test@example.com" }))],
  ])("rejects %s", (_label, value) => {
    expect(() => sanitizeListAvailableModelsResponse(value, source)).toThrow("Unsafe ListAvailableModels response");
  });

  it("rejects duplicate IDs and a missing default model", () => {
    const duplicate = model();
    expect(() =>
      sanitizeListAvailableModelsResponse(
        { defaultModel: { modelId: duplicate.modelId }, models: [duplicate, duplicate] },
        source,
      ),
    ).toThrow("models.duplicate-id");
    expect(() =>
      sanitizeListAvailableModelsResponse({ defaultModel: { modelId: "auto" }, models: [duplicate] }, source),
    ).toThrow("default-model.missing");
  });
});

describe("captured Kiro CLI 2.13.1 fixture", () => {
  it("is identity-free and contains the live model and reasoning metadata", () => {
    const fixture = JSON.parse(
      readFileSync("test/fixtures/kiro-list-available-models-2.13.1.json", "utf-8"),
    ) as SanitizedListAvailableModelsResponse;
    expect(() => assertSanitizedFixtureSafe(fixture)).not.toThrow();
    expect(fixture.models).toHaveLength(18);
    expect(fixture.defaultModel.modelId).toBe("auto");
    expect(fixture.models.find((model) => model.modelId === "gpt-5.6-sol")?.supportedInputTypes).toEqual([
      "TEXT",
      "IMAGE",
    ]);
    expect(
      fixture.models.find((model) => model.modelId === "gpt-5.6-sol")?.additionalModelRequestFieldsSchema?.properties
        ?.reasoning?.properties?.effort?.enum,
    ).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(
      fixture.models.find((model) => model.modelId === "claude-opus-4.8")?.additionalModelRequestFieldsSchema
        ?.properties?.output_config?.properties?.effort?.enum,
    ).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});
