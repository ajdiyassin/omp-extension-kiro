// ABOUTME: Kiro stream event parsing for JSON-based streaming responses.
// ABOUTME: Extracts typed events from raw buffered stream data.

export interface KiroUsageData {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
}

export type KiroStreamEvent =
  | { type: "content"; data: string; stopReason?: string }
  | { type: "reasoning"; data: { text?: string; signature?: string } }
  | { type: "toolUse"; data: { name: string; toolUseId: string; input: string; stop?: boolean } }
  | { type: "toolUseInput"; data: { input: string } }
  | { type: "toolUseStop"; data: { stop: boolean } }
  | { type: "contextUsage"; data: { contextUsagePercentage: number } }
  | { type: "followupPrompt"; data: string }
  | { type: "usage"; data: KiroUsageData }
  | { type: "error"; data: { error: string; message?: string } };

const USAGE_ALIASES = {
  inputTokens: ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"],
  outputTokens: ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"],
  cacheReadTokens: ["cacheReadTokens", "cache_read_tokens", "cacheReadInputTokens", "cachedTokens"],
  cacheCreationTokens: [
    "cacheCreationTokens",
    "cache_creation_tokens",
    "cacheWriteTokens",
    "cache_write_tokens",
    "cacheCreationInputTokens",
  ],
  reasoningTokens: ["reasoningTokens", "reasoning_tokens", "reasoningOutputTokens"],
} as const satisfies Record<keyof KiroUsageData, readonly string[]>;

const USAGE_SOURCE_KEYS = Object.values(USAGE_ALIASES).flat();

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeUsageData(value: unknown): KiroUsageData | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const normalized: KiroUsageData = {};
  for (const [field, aliases] of Object.entries(USAGE_ALIASES) as Array<[keyof KiroUsageData, readonly string[]]>) {
    for (const alias of aliases) {
      const metric = finiteNonNegative(source[alias]);
      if (metric !== undefined) {
        normalized[field] = metric;
        break;
      }
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

export function findJsonEnd(text: string, start: number): number {
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === "\\") {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === "{") braceCount++;
      else if (char === "}") {
        braceCount--;
        if (braceCount === 0) return i;
      }
    }
  }
  return -1;
}

export function parseKiroEvent(parsed: Record<string, unknown>, eventType?: string): KiroStreamEvent | null {
  if (parsed.content !== undefined) {
    return {
      type: "content",
      data: parsed.content as string,
      stopReason: parsed.stopReason as string | undefined,
    };
  }
  // reasoningContentEvent: distinguished by event-type header, not JSON keys
  // Both reasoning and assistantResponse can have {"text":...}, so we check eventType
  if (eventType === "reasoningContentEvent") {
    return {
      type: "reasoning",
      data: {
        text: parsed.text as string | undefined,
        signature: parsed.signature as string | undefined,
      },
    };
  }
  if (parsed.name && parsed.toolUseId) {
    const input =
      typeof parsed.input === "string"
        ? parsed.input
        : parsed.input &&
            typeof parsed.input === "object" &&
            Object.keys(parsed.input as Record<string, unknown>).length > 0
          ? JSON.stringify(parsed.input)
          : "";
    return {
      type: "toolUse",
      data: {
        name: parsed.name as string,
        toolUseId: parsed.toolUseId as string,
        input,
        stop: parsed.stop as boolean | undefined,
      },
    };
  }
  if (parsed.input !== undefined && !parsed.name) {
    return {
      type: "toolUseInput",
      data: { input: parsed.input as string },
    };
  }
  if (parsed.stop !== undefined && parsed.contextUsagePercentage === undefined)
    return { type: "toolUseStop", data: { stop: parsed.stop as boolean } };
  if (parsed.contextUsagePercentage !== undefined)
    return { type: "contextUsage", data: { contextUsagePercentage: parsed.contextUsagePercentage as number } };
  if (parsed.followupPrompt !== undefined) return { type: "followupPrompt", data: parsed.followupPrompt as string };
  if (parsed.error !== undefined || parsed.Error !== undefined) {
    return {
      type: "error",
      data: {
        error: (parsed.error || parsed.Error) as string,
        message: parsed.message as string | undefined,
      },
    };
  }
  for (const key of ["usage", "metricsEvent", "metrics", "usageEvent"] as const) {
    const usage = normalizeUsageData(parsed[key]);
    if (usage) return { type: "usage", data: usage };
  }
  if (eventType === "metricsEvent" || USAGE_SOURCE_KEYS.some((key) => key in parsed)) {
    const usage = normalizeUsageData(parsed);
    if (usage) return { type: "usage", data: usage };
  }
  return null;
}

// Known JSON key patterns that start Kiro event objects. Using specific
// patterns avoids matching stray '{"' sequences in the binary AWS Event
// Stream framing that wraps each JSON payload.
const EVENT_PATTERNS = [
  '{"content":',
  '{"name":',
  '{"input":',
  '{"stop":',
  '{"contextUsagePercentage":',
  '{"followupPrompt":',
  '{"usage":',
  '{"metricsEvent":',
  '{"metrics":',
  '{"usageEvent":',
  ...USAGE_SOURCE_KEYS.map((key) => `{"${key}":`),
  '{"toolUseId":',
  '{"unit":',
  '{"error":',
  '{"Error":',
  '{"message":',
  '{"text":', // reasoningContentEvent
  '{"signature":', // reasoningContentEvent signature frame
];

/**
 * Extract the AWS eventstream event-type header from a binary frame.
 * The header format is: :event-type\x07\x00<len><name>
 * Returns the event-type name or undefined if not found.
 */
export function extractEventType(buffer: string, jsonStart: number): string | undefined {
  // Look backwards from jsonStart to find the event-type header
  // The pattern is: :event-type\x07\x00<len><name>
  // A constructor avoids embedding binary AWS framing bytes in a regex literal.
  // biome-ignore lint/complexity/useRegexLiterals: binary framing escapes are clearer as raw text
  const headerPattern = new RegExp(String.raw`:event-type\x07\x00[\x00-\xff]([\x20-\x7e]{5,40}?)(?:\r|:content-type)`);
  // Search in a reasonable window before the JSON (max 200 bytes back)
  const searchStart = Math.max(0, jsonStart - 200);
  const window = buffer.substring(searchStart, jsonStart);
  const match = window.match(headerPattern);
  return match ? match[1] : undefined;
}

function findNextEventStart(buffer: string, from: number): number {
  let earliest = -1;
  for (const pattern of EVENT_PATTERNS) {
    const idx = buffer.indexOf(pattern, from);
    if (idx >= 0 && (earliest < 0 || idx < earliest)) earliest = idx;
  }
  return earliest;
}

function preserveEventFrameStart(buffer: string, jsonStart: number, from: number): number {
  const searchStart = Math.max(from, jsonStart - 200);
  const headerStart = buffer.lastIndexOf(":event-type", jsonStart);
  return headerStart >= searchStart ? headerStart : jsonStart;
}

function findPartialEventStart(buffer: string, from: number): number {
  const maxPatternLength = Math.max(...EVENT_PATTERNS.map((pattern) => pattern.length));
  const searchStart = Math.max(from, buffer.length - maxPatternLength + 1);
  for (let candidate = searchStart; candidate < buffer.length; candidate++) {
    const suffix = buffer.substring(candidate);
    if (EVENT_PATTERNS.some((pattern) => suffix.length < pattern.length && pattern.startsWith(suffix))) {
      return preserveEventFrameStart(buffer, candidate, from);
    }
  }
  return -1;
}

export function parseKiroEvents(buffer: string): { events: KiroStreamEvent[]; remaining: string } {
  const events: KiroStreamEvent[] = [];
  let pos = 0;

  while (pos < buffer.length) {
    const jsonStart = findNextEventStart(buffer, pos);
    if (jsonStart < 0) {
      const partialStart = findPartialEventStart(buffer, pos);
      return { events, remaining: partialStart >= 0 ? buffer.substring(partialStart) : "" };
    }

    const jsonEnd = findJsonEnd(buffer, jsonStart);
    if (jsonEnd < 0) {
      // Incomplete JSON at end of buffer — preserve its event header for the next call.
      return { events, remaining: buffer.substring(preserveEventFrameStart(buffer, jsonStart, pos)) };
    }

    try {
      const parsed = JSON.parse(buffer.substring(jsonStart, jsonEnd + 1));
      const eventType = extractEventType(buffer, jsonStart);
      const event = parseKiroEvent(parsed, eventType);
      if (event) events.push(event);
    } catch {
      /* skip brace-balanced but non-JSON content */
    }
    pos = jsonEnd + 1;
  }

  return { events, remaining: "" };
}
