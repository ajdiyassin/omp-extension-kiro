// ABOUTME: Validates and sanitizes Kiro ListAvailableModels responses for safe fixture publication.
// ABOUTME: Reconstructs an allowlisted projection and rejects unknown or identity-bearing data.

export interface SanitizedJsonSchema {
  type?: string;
  properties?: Record<string, SanitizedJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: Array<string | number | boolean | null>;
  default?: string | number | boolean | null;
  minimum?: number;
  maximum?: number;
  items?: SanitizedJsonSchema;
  oneOf?: SanitizedJsonSchema[];
  anyOf?: SanitizedJsonSchema[];
}

export interface SanitizedKiroModel {
  modelId: string;
  modelName: string;
  description?: string;
  supportedInputTypes: Array<"TEXT" | "IMAGE">;
  tokenLimits: {
    maxInputTokens: number;
    maxOutputTokens: number;
  };
  additionalModelRequestFieldsSchema?: SanitizedJsonSchema;
  promptCaching?: {
    supportsPromptCaching: boolean;
    maximumCacheCheckpointsPerRequest?: number;
    minimumTokensPerCacheCheckpoint?: number;
  };
  rateMultiplier?: number;
  rateUnit?: string;
}

export interface SanitizedKiroModelCatalog {
  defaultModel: { modelId: string };
  models: SanitizedKiroModel[];
}

export interface SanitizedListAvailableModelsResponse extends SanitizedKiroModelCatalog {
  fixtureVersion: 1;
  source: {
    client: "kiro-cli";
    clientVersion: string;
    operation: "ListAvailableModels";
    apiRegion: "us-east-1" | "eu-central-1";
    credentialKind: "api-key" | "oauth-idc" | "oauth-desktop";
    capturedAt: string;
  };
  defaultModel: { modelId: string };
  models: SanitizedKiroModel[];
}

const TOP_LEVEL_KEYS = new Set(["defaultModel", "models"]);
const MODEL_KEYS = new Set([
  "additionalModelRequestFieldsSchema",
  "description",
  "modelId",
  "modelName",
  "promptCaching",
  "rateMultiplier",
  "rateUnit",
  "supportedInputTypes",
  "tokenLimits",
]);
const PROMPT_CACHING_KEYS = new Set([
  "maximumCacheCheckpointsPerRequest",
  "minimumTokensPerCacheCheckpoint",
  "supportsPromptCaching",
]);
const SCHEMA_KEYS = new Set([
  "additionalProperties",
  "anyOf",
  "default",
  "enum",
  "items",
  "maximum",
  "minimum",
  "oneOf",
  "properties",
  "required",
  "type",
]);
const FORBIDDEN_PROPERTY_NAME =
  /(authorization|cookie|secret|access_?token|refresh_?token|profile|account|email|user|arn)/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SAFE_SCHEMA_PROPERTY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const MAX_MODELS = 128;
const MAX_SCHEMA_DEPTH = 8;

function fail(code: string): never {
  throw new Error(`Unsafe ListAvailableModels response: ${code}`);
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, code: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${code}.unknown-key`);
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x1f) return true;
  }
  return false;
}

function boundedString(value: unknown, code: string, maxLength = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || hasControlCharacters(value)) {
    fail(code);
  }
  return value;
}

function safeId(value: unknown, code: string): string {
  const id = boundedString(value, code, 128);
  if (!SAFE_ID.test(id)) fail(code);
  return id;
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(code);
  return value as number;
}

function finiteNumber(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(code);
  return value;
}

function sanitizeSchemaPrimitive(value: unknown, code: string): string | number | boolean | null {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= 128 && !hasControlCharacters(value)) return value;
  return fail(code);
}

function sanitizeJsonSchema(value: unknown, depth = 0): SanitizedJsonSchema {
  if (depth > MAX_SCHEMA_DEPTH) fail("schema.depth");
  const raw = record(value, "schema.object");
  exactKeys(raw, SCHEMA_KEYS, "schema");
  const result: SanitizedJsonSchema = {};

  if (raw.type !== undefined) result.type = boundedString(raw.type, "schema.type", 32);
  if (raw.additionalProperties !== undefined) {
    if (typeof raw.additionalProperties !== "boolean") fail("schema.additionalProperties");
    result.additionalProperties = raw.additionalProperties;
  }
  if (raw.minimum !== undefined) result.minimum = finiteNumber(raw.minimum, "schema.minimum");
  if (raw.maximum !== undefined) result.maximum = finiteNumber(raw.maximum, "schema.maximum");
  if (result.minimum !== undefined && result.maximum !== undefined && result.minimum > result.maximum) {
    fail("schema.bounds");
  }
  if (raw.default !== undefined) result.default = sanitizeSchemaPrimitive(raw.default, "schema.default");

  if (raw.enum !== undefined) {
    if (!Array.isArray(raw.enum) || raw.enum.length === 0 || raw.enum.length > 32) fail("schema.enum");
    result.enum = raw.enum.map((entry) => sanitizeSchemaPrimitive(entry, "schema.enum-value"));
  }
  if (raw.required !== undefined) {
    if (!Array.isArray(raw.required) || raw.required.length > 32) fail("schema.required");
    result.required = raw.required.map((entry) => {
      const property = boundedString(entry, "schema.required-value", 64);
      if (!SAFE_SCHEMA_PROPERTY.test(property) || FORBIDDEN_PROPERTY_NAME.test(property)) fail("schema.required-value");
      return property;
    });
  }
  if (raw.properties !== undefined) {
    const properties = record(raw.properties, "schema.properties");
    if (Object.keys(properties).length > 32) fail("schema.properties-count");
    result.properties = {};
    for (const [property, schema] of Object.entries(properties)) {
      if (!SAFE_SCHEMA_PROPERTY.test(property) || FORBIDDEN_PROPERTY_NAME.test(property)) fail("schema.property-name");
      result.properties[property] = sanitizeJsonSchema(schema, depth + 1);
    }
  }
  if (raw.items !== undefined) result.items = sanitizeJsonSchema(raw.items, depth + 1);
  for (const unionKey of ["oneOf", "anyOf"] as const) {
    const union = raw[unionKey];
    if (union === undefined) continue;
    if (!Array.isArray(union) || union.length === 0 || union.length > 16) fail(`schema.${unionKey}`);
    result[unionKey] = union.map((entry) => sanitizeJsonSchema(entry, depth + 1));
  }
  return result;
}

function sanitizeModel(value: unknown): SanitizedKiroModel {
  const raw = record(value, "model.object");
  exactKeys(raw, MODEL_KEYS, "model");
  const modelId = safeId(raw.modelId, "model.id");
  const modelName = boundedString(raw.modelName, "model.name", 128);

  if (!Array.isArray(raw.supportedInputTypes) || raw.supportedInputTypes.length === 0) fail("model.input-types");
  const supportedInputTypes = raw.supportedInputTypes.map((input) => {
    if (input !== "TEXT" && input !== "IMAGE") fail("model.input-type");
    return input;
  });
  if (new Set(supportedInputTypes).size !== supportedInputTypes.length) fail("model.input-duplicate");

  const rawLimits = record(raw.tokenLimits, "model.token-limits");
  exactKeys(rawLimits, new Set(["maxInputTokens", "maxOutputTokens"]), "model.token-limits");
  const model: SanitizedKiroModel = {
    modelId,
    modelName,
    supportedInputTypes,
    tokenLimits: {
      maxInputTokens: positiveInteger(rawLimits.maxInputTokens, "model.max-input"),
      maxOutputTokens: positiveInteger(rawLimits.maxOutputTokens, "model.max-output"),
    },
  };

  if (raw.description !== undefined) model.description = boundedString(raw.description, "model.description", 512);
  if (raw.additionalModelRequestFieldsSchema !== undefined) {
    model.additionalModelRequestFieldsSchema = sanitizeJsonSchema(raw.additionalModelRequestFieldsSchema);
  }
  if (raw.promptCaching !== undefined) {
    const cache = record(raw.promptCaching, "model.prompt-caching");
    exactKeys(cache, PROMPT_CACHING_KEYS, "model.prompt-caching");
    if (typeof cache.supportsPromptCaching !== "boolean") fail("model.prompt-caching.supported");
    model.promptCaching = { supportsPromptCaching: cache.supportsPromptCaching };
    if (cache.maximumCacheCheckpointsPerRequest !== undefined) {
      model.promptCaching.maximumCacheCheckpointsPerRequest = positiveInteger(
        cache.maximumCacheCheckpointsPerRequest,
        "model.prompt-caching.maximum",
      );
    }
    if (cache.minimumTokensPerCacheCheckpoint !== undefined) {
      model.promptCaching.minimumTokensPerCacheCheckpoint = positiveInteger(
        cache.minimumTokensPerCacheCheckpoint,
        "model.prompt-caching.minimum",
      );
    }
  }
  if (raw.rateMultiplier !== undefined)
    model.rateMultiplier = finiteNumber(raw.rateMultiplier, "model.rate-multiplier");
  if (raw.rateUnit !== undefined) model.rateUnit = boundedString(raw.rateUnit, "model.rate-unit", 32);
  return model;
}

export function sanitizeKiroModelCatalog(value: unknown): SanitizedKiroModelCatalog {
  const raw = record(value, "top-level.object");
  exactKeys(raw, TOP_LEVEL_KEYS, "top-level");
  const defaultModelRaw = record(raw.defaultModel, "default-model.object");
  exactKeys(defaultModelRaw, new Set(["modelId"]), "default-model");
  const defaultModelId = safeId(defaultModelRaw.modelId, "default-model.id");
  if (!Array.isArray(raw.models) || raw.models.length === 0 || raw.models.length > MAX_MODELS) fail("models.count");
  const models = raw.models.map(sanitizeModel);
  const ids = models.map((model) => model.modelId);
  if (new Set(ids).size !== ids.length) fail("models.duplicate-id");
  if (!ids.includes(defaultModelId)) fail("default-model.missing");
  const catalog = { defaultModel: { modelId: defaultModelId }, models };
  assertSanitizedCatalogSafe(catalog);
  return catalog;
}

export function sanitizeListAvailableModelsResponse(
  value: unknown,
  source: SanitizedListAvailableModelsResponse["source"],
): SanitizedListAvailableModelsResponse {
  const catalog = sanitizeKiroModelCatalog(value);
  const fixture: SanitizedListAvailableModelsResponse = {
    fixtureVersion: 1,
    source,
    ...catalog,
  };
  assertSanitizedCatalogSafe(fixture);
  return fixture;
}

export function assertSanitizedCatalogSafe(value: unknown): void {
  const serialized = JSON.stringify(value);
  const forbidden = [
    /arn:aws/i,
    /bearer\s+[A-Za-z0-9._~-]+/i,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    /(?<![A-Za-z0-9_~+/=.-])[A-Za-z0-9_~+/=.-]{64,}(?![A-Za-z0-9_~+/=.-])/,
    /(?:access|refresh)[_-]?token/i,
    /profile[_-]?arn/i,
    /account[_-]?id/i,
    /[A-Z]:\\Users\\/i,
    /\/(?:home|Users)\//,
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  ];
  if (forbidden.some((pattern) => pattern.test(serialized))) fail("fixture.forbidden-value");
}

export function assertSanitizedFixtureSafe(value: SanitizedListAvailableModelsResponse): void {
  assertSanitizedCatalogSafe(value);
}
