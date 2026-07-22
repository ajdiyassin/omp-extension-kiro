// ABOUTME: Tests OMP provider registration and native dynamic model discovery wiring.
// ABOUTME: Ensures static models/cache hooks are absent and authentication hooks remain available.

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SanitizedListAvailableModelsResponse } from "../src/model-discovery-fixture.js";

const mockPi = () => {
  const registerProvider = vi.fn();
  return { pi: { registerProvider, on: vi.fn() } as unknown as ExtensionAPI, registerProvider };
};

afterEach(() => {
  delete process.env.KIRO_API_KEY;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Feature 1: Extension Registration", () => {
  it("exports a default function", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.default).toBe("function");
  });

  it("registers the Kiro custom API and stream handler", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    expect(registerProvider).toHaveBeenCalledOnce();
    expect(registerProvider.mock.calls[0]?.[0]).toBe("kiro");
    expect(registerProvider.mock.calls[0]?.[1]).toMatchObject({
      api: "kiro-api",
      baseUrl: "https://runtime.us-east-1.kiro.dev/",
      streamSimple: expect.any(Function),
      fetchDynamicModels: expect.any(Function),
    });
  });

  it("uses native dynamic discovery instead of static models or modifyModels", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const config = registerProvider.mock.calls[0]?.[1];
    expect(config.models).toBeUndefined();
    expect(config.oauth.modifyModels).toBeUndefined();
  });

  it("maps the sanitized live catalog through fetchDynamicModels", async () => {
    const fixture = JSON.parse(
      readFileSync("test/fixtures/kiro-list-available-models-2.13.1.json", "utf-8"),
    ) as SanitizedListAvailableModelsResponse;
    process.env.KIRO_API_KEY = "configured-key";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ defaultModel: fixture.defaultModel, models: fixture.models }), { status: 200 }),
        ),
    );

    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);
    const models = await registerProvider.mock.calls[0]?.[1].fetchDynamicModels(undefined);

    expect(models).toHaveLength(18);
    expect(models.find((model: { id: string }) => model.id === "gpt-5.6-sol")).toBeDefined();
    expect(models.find((model: { id: string }) => model.id === "claude-sonnet-5")?.maxTokens).toBe(128000);
  });

  it("registers OAuth and usage hooks", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);

    const oauth = registerProvider.mock.calls[0]?.[1].oauth;
    expect(oauth.name).toBe("Kiro");
    expect(typeof oauth.login).toBe("function");
    expect(typeof oauth.refreshToken).toBe("function");
    expect(typeof oauth.getApiKey).toBe("function");
    expect(typeof oauth.fetchUsage).toBe("function");
  });

  it("getCliCredentials prefers KIRO_API_KEY over the Kiro CLI database", async () => {
    const mod = await import("../src/index.js");
    const { pi, registerProvider } = mockPi();
    mod.default(pi);
    const getCliCredentials = registerProvider.mock.calls[0]?.[1].oauth.getCliCredentials as () => unknown;

    const kiroCliMod = await import("../src/kiro-cli.js");
    const cliCreds = {
      access: "cli-access-token",
      refresh: "cli-refresh",
      expires: Number.POSITIVE_INFINITY,
      region: "eu-central-1",
      authMethod: "idc" as const,
      clientId: "client",
      clientSecret: "secret",
    };
    vi.spyOn(kiroCliMod, "getKiroCliCredentials").mockReturnValue(cliCreds);

    process.env.KIRO_API_KEY = "configured-key";
    expect(getCliCredentials()).toMatchObject({ access: "configured-key" });
    delete process.env.KIRO_API_KEY;
    expect(getCliCredentials()).toMatchObject({ access: "cli-access-token" });
  });
});
