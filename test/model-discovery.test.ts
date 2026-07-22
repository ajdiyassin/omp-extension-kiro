// ABOUTME: Locks Kiro's live discovery metadata to OMP's canonical model contract.
// ABOUTME: Covers exact IDs, modalities, output ceilings, and both reasoning schema families.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mapKiroModelCatalog } from "../src/model-discovery.js";
import type {
  SanitizedJsonSchema,
  SanitizedKiroModelCatalog,
  SanitizedListAvailableModelsResponse,
} from "../src/model-discovery-fixture.js";

const fixture = JSON.parse(
  readFileSync("test/fixtures/kiro-list-available-models-2.13.1.json", "utf-8"),
) as SanitizedListAvailableModelsResponse;

function cloneCatalog(): SanitizedKiroModelCatalog {
  return structuredClone({ defaultModel: fixture.defaultModel, models: fixture.models });
}

describe("Kiro dynamic model mapping", () => {
  it("maps all 18 live models and preserves exact dotted GPT IDs", () => {
    const models = mapKiroModelCatalog(fixture);
    expect(models).toHaveLength(18);
    expect(models.map((model) => model.id)).toContain("gpt-5.6-sol");
    expect(models.map((model) => model.id)).not.toContain("gpt-5-6-sol");
  });

  it("maps live modalities, limits, and credit multipliers", () => {
    const models = mapKiroModelCatalog(fixture);
    expect(models.find((model) => model.id === "deepseek-3.2")).toMatchObject({
      input: ["text", "image"],
      contextWindow: 164000,
      maxTokens: 64000,
      premiumMultiplier: 0.25,
    });
    expect(models.find((model) => model.id === "minimax-m2.5")?.input).toEqual(["text"]);
  });

  it("derives Sonnet 5 adaptive thinking and the 128K combined request ceiling", () => {
    const sonnet = mapKiroModelCatalog(fixture).find((model) => model.id === "claude-sonnet-5");
    expect(sonnet).toMatchObject({
      reasoning: true,
      contextWindow: 1000000,
      maxTokens: 128000,
      thinking: {
        mode: "anthropic-adaptive",
        efforts: ["low", "medium", "high", "xhigh", "max"],
        defaultLevel: "high",
        effortMap: { minimal: "low" },
        supportsDisplay: true,
      },
    });
  });

  it("preserves Kiro's Opus 4.7 xhigh default and four-tier 4.6 ladder", () => {
    const models = mapKiroModelCatalog(fixture);
    expect(models.find((model) => model.id === "claude-opus-4.7")?.thinking?.defaultLevel).toBe("xhigh");
    expect(models.find((model) => model.id === "claude-opus-4.6")?.thinking).toMatchObject({
      efforts: ["low", "medium", "high", "max"],
      defaultLevel: "high",
      effortMap: { minimal: "low" },
    });
  });

  it("maps GPT none to OMP minimal while preserving the remaining effort ladder", () => {
    const gpt = mapKiroModelCatalog(fixture).find((model) => model.id === "gpt-5.6-sol");
    expect(gpt).toMatchObject({
      reasoning: true,
      maxTokens: 128000,
      thinking: {
        mode: "effort",
        efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
        defaultLevel: "high",
        effortMap: { minimal: "none" },
      },
    });
  });

  it("does not claim configurable reasoning for schema-less models", () => {
    const models = mapKiroModelCatalog(fixture);
    const haiku = models.find((model) => model.id === "claude-haiku-4.5");
    const auto = models.find((model) => model.id === "auto");
    expect(haiku?.reasoning).toBe(false);
    expect(haiku?.thinking).toBeUndefined();
    expect(auto?.reasoning).toBe(false);
  });

  it("rejects the whole catalog when a request schema is an unknown family", () => {
    const catalog = cloneCatalog();
    const auto = catalog.models.find((model) => model.modelId === "auto");
    if (!auto) throw new Error("fixture missing auto");
    auto.additionalModelRequestFieldsSchema = {
      type: "object",
      properties: { future_reasoning: { type: "boolean" } },
    };
    expect(() => mapKiroModelCatalog(catalog)).toThrow("unknown-family");
  });

  it("rejects an invalid adaptive default instead of silently guessing", () => {
    const catalog = cloneCatalog();
    const sonnet = catalog.models.find((model) => model.modelId === "claude-sonnet-5");
    const effort = sonnet?.additionalModelRequestFieldsSchema?.properties?.output_config?.properties?.effort;
    if (!effort) throw new Error("fixture missing Sonnet effort schema");
    effort.default = "unsupported";
    expect(() => mapKiroModelCatalog(catalog)).toThrow("anthropic.default");
  });

  it("rejects extra keywords and incompatible required fields in recognized schemas", () => {
    const extraKeywordCatalog = cloneCatalog();
    const extraRoot = extraKeywordCatalog.models.find(
      (model) => model.modelId === "gpt-5.6-sol",
    )?.additionalModelRequestFieldsSchema;
    if (!extraRoot) throw new Error("fixture missing GPT schema");
    (extraRoot as SanitizedJsonSchema & { anyOf?: unknown[] }).anyOf = [];
    expect(() => mapKiroModelCatalog(extraKeywordCatalog)).toThrow("gpt.root");

    const requiredCatalog = cloneCatalog();
    const thinking = requiredCatalog.models.find((model) => model.modelId === "claude-sonnet-5")
      ?.additionalModelRequestFieldsSchema?.properties?.thinking;
    if (!thinking) throw new Error("fixture missing Sonnet thinking schema");
    thinking.required = ["display"];
    expect(() => mapKiroModelCatalog(requiredCatalog)).toThrow("anthropic.thinking.required");
  });

  it("rejects invalid adaptive max-token types and bounds", () => {
    const wrongTypeCatalog = cloneCatalog();
    const wrongType = wrongTypeCatalog.models.find((model) => model.modelId === "claude-sonnet-5")
      ?.additionalModelRequestFieldsSchema?.properties?.max_tokens;
    if (!wrongType) throw new Error("fixture missing Sonnet max_tokens schema");
    wrongType.type = "number";
    expect(() => mapKiroModelCatalog(wrongTypeCatalog)).toThrow("anthropic.max_tokens");

    const wrongBoundsCatalog = cloneCatalog();
    const wrongBounds = wrongBoundsCatalog.models.find((model) => model.modelId === "claude-sonnet-5")
      ?.additionalModelRequestFieldsSchema?.properties?.max_tokens;
    if (!wrongBounds) throw new Error("fixture missing Sonnet max_tokens schema");
    wrongBounds.minimum = 128001;
    expect(() => mapKiroModelCatalog(wrongBoundsCatalog)).toThrow("anthropic.max_tokens");
  });

  it("normalizes reordered Claude effort enums before mapping minimal", () => {
    const catalog = cloneCatalog();
    const effort = catalog.models.find((model) => model.modelId === "claude-sonnet-5")
      ?.additionalModelRequestFieldsSchema?.properties?.output_config?.properties?.effort;
    if (!effort) throw new Error("fixture missing Sonnet effort schema");
    effort.enum = ["high", "max", "low", "xhigh", "medium"];
    const sonnet = mapKiroModelCatalog(catalog).find((model) => model.id === "claude-sonnet-5");
    expect(sonnet?.thinking).toMatchObject({
      efforts: ["low", "medium", "high", "xhigh", "max"],
      effortMap: { minimal: "low" },
    });
  });

  it.each([
    ["unknown rate unit", { rateUnit: "USD", rateMultiplier: 2.4 }],
    ["multiplier without unit", { rateUnit: undefined, rateMultiplier: 2.4 }],
    ["unit without multiplier", { rateUnit: "Credit", rateMultiplier: undefined }],
  ])("rejects %s", (_label, rateMetadata) => {
    const catalog = cloneCatalog();
    const model = catalog.models[0];
    if (!model) throw new Error("fixture contains no models");
    Object.assign(model, rateMetadata);
    expect(() => mapKiroModelCatalog(catalog)).toThrow("Unsupported Kiro rate metadata");
  });
});
