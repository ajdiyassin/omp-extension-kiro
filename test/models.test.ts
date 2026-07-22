// ABOUTME: Tests Kiro endpoint routing and explicit legacy model aliases.
// ABOUTME: Model availability and capability coverage lives in dynamic discovery tests.

import { describe, expect, it } from "vitest";
import {
  endpointForApiRegion,
  extractRegionFromEndpoint,
  extractRegionFromProfileArn,
  managementEndpointForApiRegion,
  resolveApiRegion,
  resolveKiroModel,
} from "../src/models.js";

describe("Kiro model ID compatibility", () => {
  it.each([
    ["claude-opus-4-8", "claude-opus-4.8"],
    ["claude-sonnet-4-6", "claude-sonnet-4.6"],
    ["deepseek-3-2", "deepseek-3.2"],
    ["minimax-m2-5", "minimax-m2.5"],
  ])("maps the explicit legacy selector %s to %s", (legacy, current) => {
    expect(resolveKiroModel(legacy)).toBe(current);
  });

  it.each([
    "gpt-5.6-sol",
    "claude-sonnet-5",
    "auto",
    "future.model-7.2",
  ])("preserves exact server ID %s without generic rewriting or a whitelist", (modelId) => {
    expect(resolveKiroModel(modelId)).toBe(modelId);
  });
});

describe("Kiro API region routing", () => {
  it.each([
    ["us-east-2", "us-east-1"],
    ["eu-west-1", "eu-central-1"],
    ["ap-southeast-2", "us-east-1"],
    ["us-east-1", "us-east-1"],
    [undefined, "us-east-1"],
  ])("maps %s to %s", (source, expected) => {
    expect(resolveApiRegion(source)).toBe(expected);
  });

  it("constructs runtime and management endpoints", () => {
    expect(endpointForApiRegion("eu-central-1")).toBe("https://runtime.eu-central-1.kiro.dev/");
    expect(managementEndpointForApiRegion("us-east-1")).toBe("https://management.us-east-1.kiro.dev/");
  });

  it("extracts current and legacy endpoint regions", () => {
    expect(extractRegionFromEndpoint("https://runtime.us-east-1.kiro.dev/")).toBe("us-east-1");
    expect(extractRegionFromEndpoint("https://management.eu-central-1.kiro.dev/")).toBe("eu-central-1");
    expect(extractRegionFromEndpoint("https://q.us-east-1.amazonaws.com/generateAssistantResponse")).toBe("us-east-1");
    expect(extractRegionFromEndpoint("not-a-url")).toBeUndefined();
  });

  it("extracts profile regions without accepting unrelated values", () => {
    expect(extractRegionFromProfileArn("arn:aws:codewhisperer:eu-central-1:123:profile/abc")).toBe("eu-central-1");
    expect(extractRegionFromProfileArn("not-an-arn")).toBeUndefined();
    expect(extractRegionFromProfileArn(undefined)).toBeUndefined();
  });
});
