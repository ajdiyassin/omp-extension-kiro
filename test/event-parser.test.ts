import { describe, expect, it } from "vitest";
import { extractEventType, findJsonEnd, parseKiroEvent, parseKiroEvents } from "../src/event-parser.js";

describe("Feature 8: Stream Event Parsing", () => {
  describe("findJsonEnd", () => {
    it("finds end of simple object", () => {
      expect(findJsonEnd('{"content":"hello"}rest', 0)).toBe(18);
    });

    it("handles nested braces", () => {
      expect(findJsonEnd('{"input":{"cmd":"ls"}}rest', 0)).toBe(21);
    });

    it("handles escaped quotes", () => {
      expect(findJsonEnd('{"content":"say \\"hi\\""}rest', 0)).toBe(23);
    });

    it("returns -1 for incomplete JSON", () => {
      expect(findJsonEnd('{"content":"hel', 0)).toBe(-1);
    });

    it("respects start offset", () => {
      expect(findJsonEnd('garbage{"content":"hi"}', 7)).toBe(22);
    });
  });

  describe("parseKiroEvent", () => {
    it("parses content event", () => {
      expect(parseKiroEvent({ content: "Hello " })).toEqual({ type: "content", data: "Hello " });
    });

    it("parses toolUse event", () => {
      expect(parseKiroEvent({ name: "bash", toolUseId: "tool_1", input: "ls" })).toEqual({
        type: "toolUse",
        data: { name: "bash", toolUseId: "tool_1", input: "ls", stop: undefined },
      });
    });

    it("parses toolUse with stop", () => {
      expect(parseKiroEvent({ name: "bash", toolUseId: "tool_1", input: "ls", stop: true })).toEqual({
        type: "toolUse",
        data: { name: "bash", toolUseId: "tool_1", input: "ls", stop: true },
      });
    });

    it("parses toolUseInput", () => {
      expect(parseKiroEvent({ input: '"ls"}' })).toEqual({ type: "toolUseInput", data: { input: '"ls"}' } });
    });

    it("parses toolUseStop", () => {
      expect(parseKiroEvent({ stop: true })).toEqual({ type: "toolUseStop", data: { stop: true } });
    });

    it("parses reasoningContentEvent with text", () => {
      expect(parseKiroEvent({ text: "I am thinking" }, "reasoningContentEvent")).toEqual({
        type: "reasoning",
        data: { text: "I am thinking", signature: undefined },
      });
    });

    it("parses reasoningContentEvent with signature", () => {
      expect(
        parseKiroEvent(
          {
            signature:
              "ErUDCmMIDxABGAIqQIJqm4WKIDMBZf0TxmYU/XvJYi6yxr2zS68elaTxB3OHtorU4pUZ+doX5rQPfP1rzhDX+UKzLtJmR1kRV8Izu1IyDWNsYXVkZS1xdWluY2U4AEIIdGhpbmtpbmcSDEBTBDtqL7l5T+TGnxoM1X544B+2o6KPO2oDIjDkGc+j2hFjPZPTWod3q+li05Mbz0Y3jevF72ReYsZcQEPQf0fKBkgnrFKBS2T9rscq/wFm2Ziu0gIqTKNGhm1Gn8H7ZLkeMMe4QguMgklrqxzVJZS+XhSJ/zeTsF3BQg2R5rqZ4wSHP7Iwvnp3RRIshK59E7CZjFjG6OYje2FYSjrsvjPEqRV3wwNJhuEk5Y/UJaiNEBjHIRqhhQ/kyanF5FmN2RHAV4d/yKtiVm28eousAdqyCydZ0Gpn08MJ2O65fViYAJENGku97yTA9UBD53EISqwTUSskOcuLXMUS0FpuMMQgjya8UUfok0kKNqzfLb6kuYAJbA9WJReHIP2SMnDoWGRF65fJgEhGckgAEqJqil3YaHRymwAFK8ccaU6Dba/AYR7Cdqjy0TkCremDxaUYAQ==",
          },
          "reasoningContentEvent",
        ),
      ).toEqual({
        type: "reasoning",
        data: {
          text: undefined,
          signature:
            "ErUDCmMIDxABGAIqQIJqm4WKIDMBZf0TxmYU/XvJYi6yxr2zS68elaTxB3OHtorU4pUZ+doX5rQPfP1rzhDX+UKzLtJmR1kRV8Izu1IyDWNsYXVkZS1xdWluY2U4AEIIdGhpbmtpbmcSDEBTBDtqL7l5T+TGnxoM1X544B+2o6KPO2oDIjDkGc+j2hFjPZPTWod3q+li05Mbz0Y3jevF72ReYsZcQEPQf0fKBkgnrFKBS2T9rscq/wFm2Ziu0gIqTKNGhm1Gn8H7ZLkeMMe4QguMgklrqxzVJZS+XhSJ/zeTsF3BQg2R5rqZ4wSHP7Iwvnp3RRIshK59E7CZjFjG6OYje2FYSjrsvjPEqRV3wwNJhuEk5Y/UJaiNEBjHIRqhhQ/kyanF5FmN2RHAV4d/yKtiVm28eousAdqyCydZ0Gpn08MJ2O65fViYAJENGku97yTA9UBD53EISqwTUSskOcuLXMUS0FpuMMQgjya8UUfok0kKNqzfLb6kuYAJbA9WJReHIP2SMnDoWGRF65fJgEhGckgAEqJqil3YaHRymwAFK8ccaU6Dba/AYR7Cdqjy0TkCremDxaUYAQ==",
        },
      });
    });

    it("parses content event with stopReason", () => {
      expect(parseKiroEvent({ content: "Hello", stopReason: "END_TURN" })).toEqual({
        type: "content",
        data: "Hello",
        stopReason: "END_TURN",
      });
    });

    it("parses contextUsage", () => {
      expect(parseKiroEvent({ contextUsagePercentage: 42.5 })).toEqual({
        type: "contextUsage",
        data: { contextUsagePercentage: 42.5 },
      });
    });

    it("parses followupPrompt event", () => {
      const e = parseKiroEvent({ followupPrompt: "What would you like to do next?" });
      expect(e).toEqual({ type: "followupPrompt", data: "What would you like to do next?" });
    });

    it("parses usage event", () => {
      expect(parseKiroEvent({ usage: { inputTokens: 100, outputTokens: 50 } })).toEqual({
        type: "usage",
        data: { inputTokens: 100, outputTokens: 50 },
      });
    });

    it.each([
      ["metricsEvent", { metricsEvent: { inputTokens: 1 } }],
      ["metrics", { metrics: { outputTokens: 2 } }],
      ["usageEvent", { usageEvent: { cacheReadTokens: 3 } }],
    ])("parses nested %s usage envelopes", (_name, payload) => {
      expect(parseKiroEvent(payload)).toMatchObject({ type: "usage" });
    });

    it("normalizes all usage fields and camelCase aliases", () => {
      expect(
        parseKiroEvent({
          metricsEvent: {
            inputTokens: 100,
            outputTokens: 40,
            cacheReadTokens: 50,
            cacheCreationTokens: 10,
            reasoningTokens: 12,
          },
        }),
      ).toEqual({
        type: "usage",
        data: {
          inputTokens: 100,
          outputTokens: 40,
          cacheReadTokens: 50,
          cacheCreationTokens: 10,
          reasoningTokens: 12,
        },
      });
    });

    it("normalizes snake_case and alternate token aliases", () => {
      expect(
        parseKiroEvent({
          metrics: {
            prompt_tokens: 11,
            completion_tokens: 12,
            cache_read_tokens: 13,
            cache_write_tokens: 14,
            reasoning_tokens: 5,
          },
        }),
      ).toEqual({
        type: "usage",
        data: {
          inputTokens: 11,
          outputTokens: 12,
          cacheReadTokens: 13,
          cacheCreationTokens: 14,
          reasoningTokens: 5,
        },
      });
      expect(
        parseKiroEvent({
          usageEvent: {
            promptTokens: 21,
            completionTokens: 22,
            cacheReadInputTokens: 23,
            cacheCreationInputTokens: 24,
            reasoningOutputTokens: 6,
          },
        }),
      ).toEqual({
        type: "usage",
        data: {
          inputTokens: 21,
          outputTokens: 22,
          cacheReadTokens: 23,
          cacheCreationTokens: 24,
          reasoningTokens: 6,
        },
      });
    });

    it("parses a flat metricsEvent frame and preserves zero values", () => {
      expect(
        parseKiroEvent(
          { input_tokens: 0, output_tokens: 0, cachedTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 },
          "metricsEvent",
        ),
      ).toEqual({
        type: "usage",
        data: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
        },
      });
    });

    it("omits invalid metrics without coercion and rejects empty metric objects", () => {
      expect(
        parseKiroEvent({
          metricsEvent: {
            inputTokens: "100",
            outputTokens: -1,
            cacheReadTokens: Number.NaN,
            cacheCreationTokens: Number.POSITIVE_INFINITY,
            reasoningTokens: 2,
          },
        }),
      ).toEqual({ type: "usage", data: { reasoningTokens: 2 } });
      expect(parseKiroEvent({ metricsEvent: { inputTokens: "100", outputTokens: -1 } })).toBeNull();
    });

    it("returns null for unrecognized shape", () => {
      expect(parseKiroEvent({ unknown: true })).toBeNull();
    });

    it("treats empty object input as empty string for toolUse placeholder", () => {
      expect(parseKiroEvent({ name: "bash", toolUseId: "tool_1", input: {} })).toEqual({
        type: "toolUse",
        data: { name: "bash", toolUseId: "tool_1", input: "", stop: undefined },
      });
    });

    it("preserves non-empty object input as JSON string", () => {
      expect(parseKiroEvent({ name: "bash", toolUseId: "tool_1", input: { cmd: "ls" } })).toEqual({
        type: "toolUse",
        data: { name: "bash", toolUseId: "tool_1", input: '{"cmd":"ls"}', stop: undefined },
      });
    });
  });

  describe("extractEventType", () => {
    it("returns undefined when event-type header not found", () => {
      const buffer = '{"text":"hello"}';
      const jsonStart = 0;
      const eventType = extractEventType(buffer, jsonStart);
      expect(eventType).toBeUndefined();
    });

    it("extracts reasoningContentEvent from the eventstream header", () => {
      // AWS eventstream header format: :event-type\x07\x00<len><name>...:content-type
      const buffer =
        ":event-type\x07\x00\x13reasoningContentEvent:content-type\x07\x00\x10application/json" +
        '{"text":"I am thinking"}';
      const jsonStart = buffer.indexOf('{"text"');
      expect(extractEventType(buffer, jsonStart)).toBe("reasoningContentEvent");
    });

    it("extracts assistantResponseEvent from the eventstream header", () => {
      const buffer =
        ":event-type\x07\x00\x14assistantResponseEvent:content-type\x07\x00\x10application/json" + '{"content":"Hi"}';
      const jsonStart = buffer.indexOf('{"content"');
      expect(extractEventType(buffer, jsonStart)).toBe("assistantResponseEvent");
    });
  });

  describe("parseKiroEvents", () => {
    it("parses multiple events from buffer", () => {
      const buffer = '{"content":"Hello"}{"content":" world"}';
      const { events, remaining } = parseKiroEvents(buffer);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: "content", data: "Hello" });
      expect(events[1]).toEqual({ type: "content", data: " world" });
      expect(remaining).toBe("");
    });

    it("preserves incomplete JSON for next call", () => {
      const buffer = '{"content":"Hello"}{"content":"incomplete';
      const { events, remaining } = parseKiroEvents(buffer);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "content", data: "Hello" });
      expect(remaining).toBe('{"content":"incomplete');
    });

    it("handles empty buffer", () => {
      const { events, remaining } = parseKiroEvents("");
      expect(events).toHaveLength(0);
      expect(remaining).toBe("");
    });

    it("skips non-JSON brace-balanced content", () => {
      const buffer = '{"content":"Hello"}{{not json}}{"content":"world"}';
      const { events } = parseKiroEvents(buffer);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: "content", data: "Hello" });
      expect(events[1]).toEqual({ type: "content", data: "world" });
    });

    it("parses toolUse events", () => {
      const buffer = '{"name":"bash","toolUseId":"tool_1","input":"ls"}';
      const { events } = parseKiroEvents(buffer);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "toolUse",
        data: { name: "bash", toolUseId: "tool_1", input: "ls", stop: undefined },
      });
    });

    it("parses contextUsage event", () => {
      const buffer = '{"contextUsagePercentage":42.5}';
      const { events } = parseKiroEvents(buffer);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "contextUsage", data: { contextUsagePercentage: 42.5 } });
    });

    it("parses usage event", () => {
      const buffer = '{"usage":{"inputTokens":100,"outputTokens":50}}';
      const { events } = parseKiroEvents(buffer);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "usage", data: { inputTokens: 100, outputTokens: 50 } });
    });

    it("discovers nested and flat metrics payloads, including a payload split across chunks", () => {
      const nested = parseKiroEvents(
        '{"metricsEvent":{"inputTokens":100,"cacheReadTokens":50}}' +
          '{"metrics":{"output_tokens":40}}' +
          '{"usageEvent":{"cache_write_tokens":10}}',
      );
      expect(nested.events).toEqual([
        { type: "usage", data: { inputTokens: 100, cacheReadTokens: 50 } },
        { type: "usage", data: { outputTokens: 40 } },
        { type: "usage", data: { cacheCreationTokens: 10 } },
      ]);

      const header = ":event-type\x07\x00\x0cmetricsEvent:content-type\x07\x00\x10application/json";
      const first = parseKiroEvents(`${header}{"input_tokens":100,"output_`);
      expect(first.events).toEqual([]);
      const second = parseKiroEvents(`${first.remaining}tokens":40,"reasoning_tokens":12}`);
      expect(second.events).toEqual([
        { type: "usage", data: { inputTokens: 100, outputTokens: 40, reasoningTokens: 12 } },
      ]);
    });

    it("parses error event", () => {
      const buffer = '{"error":"Invalid request","message":"Missing field"}';
      const { events } = parseKiroEvents(buffer);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "error", data: { error: "Invalid request", message: "Missing field" } });
    });

    it("preserves metrics frames split inside their first recognized key", () => {
      const flatFirst = parseKiroEvents(
        ':event-type\x07\x00\x0cmetricsEvent:content-type\x07\x00\x10application/json{"input_tok',
      );
      expect(flatFirst.events).toEqual([]);
      expect(flatFirst.remaining).toContain('{"input_tok');
      expect(parseKiroEvents(`${flatFirst.remaining}ens":9}`).events).toEqual([
        { type: "usage", data: { inputTokens: 9 } },
      ]);

      const wrappedFirst = parseKiroEvents('{"metricsEv');
      expect(wrappedFirst).toEqual({ events: [], remaining: '{"metricsEv' });
      expect(parseKiroEvents(`${wrappedFirst.remaining}ent":{"cacheReadTokens":4}}`).events).toEqual([
        { type: "usage", data: { cacheReadTokens: 4 } },
      ]);

      const priorHeader = ":event-type\x07\x00\x14assistantResponseEvent:content-type\x07\x00\x10application/json";
      const metricsHeader = ":event-type\x07\x00\x0cmetricsEvent:content-type\x07\x00\x10application/json";
      const afterCompleteEvent = parseKiroEvents(`${priorHeader}{"content":"first"}${metricsHeader}{"metricsEv`);
      expect(afterCompleteEvent.events).toEqual([{ type: "content", data: "first", stopReason: undefined }]);
      expect(afterCompleteEvent.remaining).toBe(`${metricsHeader}{"metricsEv`);
      expect(parseKiroEvents(`${afterCompleteEvent.remaining}ent":{"outputTokens":3}}`).events).toEqual([
        { type: "usage", data: { outputTokens: 3 } },
      ]);
    });

    it("handles mixed event types", () => {
      const buffer = '{"content":"Hello"}{"contextUsagePercentage":42.5}{"content":" world"}';
      const { events } = parseKiroEvents(buffer);
      expect(events).toHaveLength(3);
      expect(events[0]).toEqual({ type: "content", data: "Hello" });
      expect(events[1]).toEqual({ type: "contextUsage", data: { contextUsagePercentage: 42.5 } });
      expect(events[2]).toEqual({ type: "content", data: " world" });
    });

    it("ignores unrecognized event shapes", () => {
      const buffer = '{"content":"Hello"}{"unknown":"value"}{"content":"world"}';
      const { events } = parseKiroEvents(buffer);
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: "content", data: "Hello" });
      expect(events[1]).toEqual({ type: "content", data: "world" });
    });
  });
});
