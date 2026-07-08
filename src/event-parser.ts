// ABOUTME: Kiro stream event parsing for JSON-based streaming responses.
// ABOUTME: Extracts typed events from raw buffered stream data.

export type KiroStreamEvent =
  | { type: "content"; data: string; stopReason?: string }
  | { type: "reasoning"; data: { text?: string; signature?: string } }
  | { type: "toolUse"; data: { name: string; toolUseId: string; input: string; stop?: boolean } }
  | { type: "toolUseInput"; data: { input: string } }
  | { type: "toolUseStop"; data: { stop: boolean } }
  | { type: "contextUsage"; data: { contextUsagePercentage: number } }
  | { type: "followupPrompt"; data: string }
  | { type: "usage"; data: { inputTokens?: number; outputTokens?: number } }
  | { type: "error"; data: { error: string; message?: string } };

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

export function parseKiroEvent(
  parsed: Record<string, unknown>,
  eventType?: string,
): KiroStreamEvent | null {
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
  if (parsed.usage !== undefined) {
    const usage = parsed.usage as Record<string, unknown>;
    return {
      type: "usage",
      data: {
        inputTokens: usage.inputTokens as number | undefined,
        outputTokens: usage.outputTokens as number | undefined,
      },
    };
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
  const headerPattern = /:event-type\x07\x00[\x00-\xff]([\x20-\x7e]{5,40}?)(?:\r|:content-type)/;
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

export function parseKiroEvents(buffer: string): { events: KiroStreamEvent[]; remaining: string } {
  const events: KiroStreamEvent[] = [];
  let pos = 0;

  while (pos < buffer.length) {
    const jsonStart = findNextEventStart(buffer, pos);
    if (jsonStart < 0) break;

    const jsonEnd = findJsonEnd(buffer, jsonStart);
    if (jsonEnd < 0) {
      // Incomplete JSON at end of buffer — preserve for next call
      return { events, remaining: buffer.substring(jsonStart) };
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
