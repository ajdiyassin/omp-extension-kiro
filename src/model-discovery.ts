// ABOUTME: Maps sanitized Kiro model metadata into OMP's canonical dynamic model contract.
// ABOUTME: Recognizes only validated Anthropic-adaptive and GPT reasoning schema families.

import type { Effort } from "@oh-my-pi/pi-ai";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import type { SanitizedJsonSchema, SanitizedKiroModel, SanitizedKiroModelCatalog } from "./model-discovery-fixture.js";

const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const ANTHROPIC_EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;
const GPT_EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const ANTHROPIC_EFFORTS = new Set<string>(ANTHROPIC_EFFORT_ORDER);
const GPT_EFFORTS = new Set<string>(GPT_EFFORT_ORDER);
const OMP_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

type OmpEffort = Effort;

type ThinkingConfig = NonNullable<ProviderModelConfig["thinking"]>;

function schemaError(modelId: string, detail: string): never {
  throw new Error(`Unsupported Kiro request schema for ${modelId}: ${detail}`);
}

function exactSchemaKeywords(
  modelId: string,
  schema: SanitizedJsonSchema | undefined,
  expected: readonly (keyof SanitizedJsonSchema)[],
  detail: string,
): asserts schema is SanitizedJsonSchema {
  if (!schema) schemaError(modelId, detail);
  const actual = Object.keys(schema).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((name, index) => name !== wanted[index])) {
    schemaError(modelId, detail);
  }
}

function exactRequired(
  modelId: string,
  schema: SanitizedJsonSchema,
  expected: readonly string[],
  detail: string,
): void {
  const actual = [...(schema.required ?? [])].sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((name, index) => name !== wanted[index])) {
    schemaError(modelId, detail);
  }
}

function exactPropertyNames(
  modelId: string,
  schema: SanitizedJsonSchema | undefined,
  expected: readonly string[],
  detail: string,
): Record<string, SanitizedJsonSchema> {
  if (schema?.type !== "object" || !schema.properties) schemaError(modelId, detail);
  const actual = Object.keys(schema.properties).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((name, index) => name !== wanted[index])) {
    schemaError(modelId, detail);
  }
  return schema.properties;
}

function stringEnum(
  modelId: string,
  schema: SanitizedJsonSchema | undefined,
  allowed: ReadonlySet<string>,
  detail: string,
): string[] {
  if (schema?.type !== "string" || !schema.enum?.length) schemaError(modelId, detail);
  const values = schema.enum.map((value) => {
    if (typeof value !== "string" || !allowed.has(value)) schemaError(modelId, detail);
    return value;
  });
  if (new Set(values).size !== values.length) schemaError(modelId, detail);
  return values;
}

function enumDefault(modelId: string, schema: SanitizedJsonSchema, values: readonly string[], detail: string): string {
  if (typeof schema.default !== "string" || !values.includes(schema.default)) schemaError(modelId, detail);
  return schema.default;
}

function anthropicThinking(model: SanitizedKiroModel): { thinking: ThinkingConfig; maxTokens: number } {
  const modelId = model.modelId;
  const rootSchema = model.additionalModelRequestFieldsSchema;
  exactSchemaKeywords(modelId, rootSchema, ["type", "additionalProperties", "properties"], "anthropic.root");
  if (rootSchema.additionalProperties !== false) schemaError(modelId, "anthropic.additionalProperties");
  const root = exactPropertyNames(modelId, rootSchema, ["thinking", "output_config", "max_tokens"], "anthropic.root");

  exactSchemaKeywords(modelId, root.thinking, ["type", "properties", "required"], "anthropic.thinking");
  exactRequired(modelId, root.thinking, ["type"], "anthropic.thinking.required");
  const thinking = exactPropertyNames(modelId, root.thinking, ["type", "display"], "anthropic.thinking");
  exactSchemaKeywords(modelId, thinking.type, ["type", "enum"], "anthropic.type");
  exactSchemaKeywords(modelId, thinking.display, ["type", "enum"], "anthropic.display");
  const thinkingTypes = stringEnum(modelId, thinking.type, new Set(["adaptive", "disabled"]), "anthropic.type");
  if (!thinkingTypes.includes("adaptive") || !thinkingTypes.includes("disabled"))
    schemaError(modelId, "anthropic.type");
  const display = stringEnum(modelId, thinking.display, new Set(["summarized", "omitted"]), "anthropic.display");
  if (!display.includes("summarized") || !display.includes("omitted")) schemaError(modelId, "anthropic.display");

  exactSchemaKeywords(modelId, root.output_config, ["type", "properties"], "anthropic.output_config");
  const outputConfig = exactPropertyNames(modelId, root.output_config, ["effort"], "anthropic.output_config");
  const effortSchema = outputConfig.effort;
  exactSchemaKeywords(modelId, effortSchema, ["type", "enum", "default"], "anthropic.effort");
  const advertisedEfforts = stringEnum(modelId, effortSchema, ANTHROPIC_EFFORTS, "anthropic.effort");
  const efforts = ANTHROPIC_EFFORT_ORDER.filter((effort) => advertisedEfforts.includes(effort)) as OmpEffort[];
  const defaultLevel = enumDefault(modelId, effortSchema, advertisedEfforts, "anthropic.default") as OmpEffort;

  const maxTokensSchema = root.max_tokens;
  exactSchemaKeywords(modelId, maxTokensSchema, ["type", "minimum", "maximum"], "anthropic.max_tokens");
  if (
    maxTokensSchema.type !== "integer" ||
    !Number.isSafeInteger(maxTokensSchema.minimum) ||
    (maxTokensSchema.minimum as number) <= 0 ||
    !Number.isSafeInteger(maxTokensSchema.maximum) ||
    (maxTokensSchema.maximum as number) < (maxTokensSchema.minimum as number)
  ) {
    schemaError(modelId, "anthropic.max_tokens");
  }

  return {
    thinking: {
      mode: "anthropic-adaptive",
      efforts,
      defaultLevel,
      effortMap: { minimal: efforts[0] },
      supportsDisplay: true,
    },
    maxTokens: maxTokensSchema.maximum as number,
  };
}

function gptThinking(model: SanitizedKiroModel): ThinkingConfig {
  const modelId = model.modelId;
  const rootSchema = model.additionalModelRequestFieldsSchema;
  exactSchemaKeywords(modelId, rootSchema, ["type", "additionalProperties", "properties"], "gpt.root");
  if (rootSchema.additionalProperties !== false) schemaError(modelId, "gpt.additionalProperties");
  const root = exactPropertyNames(modelId, rootSchema, ["reasoning"], "gpt.root");
  exactSchemaKeywords(modelId, root.reasoning, ["type", "properties"], "gpt.reasoning");
  const reasoning = exactPropertyNames(modelId, root.reasoning, ["mode", "effort"], "gpt.reasoning");
  exactSchemaKeywords(modelId, reasoning.mode, ["type", "enum", "default"], "gpt.mode");
  exactSchemaKeywords(modelId, reasoning.effort, ["type", "enum", "default"], "gpt.effort");
  const modes = stringEnum(modelId, reasoning.mode, new Set(["standard", "pro"]), "gpt.mode");
  if (!modes.includes("standard") || enumDefault(modelId, reasoning.mode, modes, "gpt.mode-default") !== "standard") {
    schemaError(modelId, "gpt.mode-default");
  }
  const advertisedWireEfforts = stringEnum(modelId, reasoning.effort, GPT_EFFORTS, "gpt.effort");
  const wireEfforts = GPT_EFFORT_ORDER.filter((effort) => advertisedWireEfforts.includes(effort));
  const efforts = wireEfforts.map((effort) => (effort === "none" ? "minimal" : effort)) as OmpEffort[];
  if (efforts.some((effort) => !OMP_EFFORTS.has(effort))) schemaError(modelId, "gpt.effort");
  const wireDefault = enumDefault(modelId, reasoning.effort, wireEfforts, "gpt.default");
  const defaultLevel = (wireDefault === "none" ? "minimal" : wireDefault) as OmpEffort;
  return {
    mode: "effort",
    efforts,
    defaultLevel,
    effortMap: wireEfforts.includes("none") ? { minimal: "none" } : undefined,
  };
}

function mapRequestSchema(model: SanitizedKiroModel): {
  reasoning: boolean;
  thinking?: ThinkingConfig;
  maxTokens: number;
} {
  const schema = model.additionalModelRequestFieldsSchema;
  if (!schema) return { reasoning: false, maxTokens: model.tokenLimits.maxOutputTokens };
  const rootProperties = schema.properties;
  if (rootProperties?.thinking || rootProperties?.output_config || rootProperties?.max_tokens) {
    const adaptive = anthropicThinking(model);
    return { reasoning: true, ...adaptive };
  }
  if (rootProperties?.reasoning) {
    return { reasoning: true, thinking: gptThinking(model), maxTokens: model.tokenLimits.maxOutputTokens };
  }
  return schemaError(model.modelId, "unknown-family");
}

function premiumMultiplier(model: SanitizedKiroModel): number | undefined {
  if (model.rateMultiplier === undefined && model.rateUnit === undefined) return undefined;
  if (model.rateMultiplier === undefined || model.rateUnit !== "Credit") {
    throw new Error(`Unsupported Kiro rate metadata for ${model.modelId}`);
  }
  return model.rateMultiplier;
}

export function mapKiroModel(model: SanitizedKiroModel): ProviderModelConfig {
  const requestMetadata = mapRequestSchema(model);
  const multiplier = premiumMultiplier(model);

  return {
    id: model.modelId,
    name: model.modelName,
    api: "kiro-api",
    reasoning: requestMetadata.reasoning,
    ...(requestMetadata.thinking ? { thinking: requestMetadata.thinking } : {}),
    input: model.supportedInputTypes.map((input) => (input === "IMAGE" ? "image" : "text")),
    cost: ZERO_COST,
    ...(multiplier !== undefined ? { premiumMultiplier: multiplier } : {}),
    contextWindow: model.tokenLimits.maxInputTokens,
    maxTokens: requestMetadata.maxTokens,
  };
}

/** Convert an authoritative sanitized catalog; one malformed model rejects the entire refresh. */
export function mapKiroModelCatalog(catalog: SanitizedKiroModelCatalog): ProviderModelConfig[] {
  return catalog.models.map(mapKiroModel);
}
