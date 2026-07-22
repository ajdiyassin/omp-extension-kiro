// ABOUTME: Tests profile-aware Kiro management routing and fail-closed model retrieval.
// ABOUTME: Verifies API-key and OAuth request shapes without exposing credential values.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchKiroModelCatalog,
  type KiroManagementCredential,
  resolveKiroManagementCredential,
  resolveKiroManagementRoute,
} from "../src/management.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rawCatalog() {
  return {
    defaultModel: { modelId: "gpt-5.6-sol" },
    models: [
      {
        modelId: "gpt-5.6-sol",
        modelName: "gpt-5.6-sol",
        supportedInputTypes: ["TEXT", "IMAGE"],
        tokenLimits: { maxInputTokens: 272000, maxOutputTokens: 128000 },
      },
    ],
  };
}

afterEach(() => {
  delete process.env.KIRO_API_KEY;
  delete process.env.KIRO_API_REGION;
  vi.restoreAllMocks();
});

describe("Kiro management credentials", () => {
  it("recognizes only an exact KIRO_API_KEY match as API-key auth", () => {
    process.env.KIRO_API_KEY = "configured-key";
    expect(resolveKiroManagementCredential("configured-key")).toMatchObject({
      kind: "api-key",
      accessToken: "configured-key",
    });
    expect(resolveKiroManagementCredential("different-bearer").kind).toBe("oauth-idc");
  });

  it("uses KIRO_API_KEY when OMP supplies no bearer", () => {
    process.env.KIRO_API_KEY = "configured-key";
    expect(resolveKiroManagementCredential(undefined)).toMatchObject({
      kind: "api-key",
      accessToken: "configured-key",
      region: "us-east-1",
    });
  });

  it("falls back to a valid Kiro CLI bearer when OMP supplies no bearer", async () => {
    const kiroCli = await import("../src/kiro-cli.js");
    vi.spyOn(kiroCli, "getKiroCliSocialToken").mockReturnValue(undefined);
    vi.spyOn(kiroCli, "getKiroCliCredentials").mockReturnValue({
      access: "cli-bearer",
      refresh: "refresh|client|secret|idc",
      expires: Date.now() + 60_000,
      clientId: "client",
      clientSecret: "secret",
      authMethod: "idc",
      region: "eu-west-1",
    });
    expect(resolveKiroManagementCredential(undefined)).toMatchObject({
      accessToken: "cli-bearer",
      kind: "oauth-idc",
      region: "eu-west-1",
    });
  });
});

describe("Kiro management routing", () => {
  it("routes API keys without profile discovery", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      resolveKiroManagementRoute({ accessToken: "key", kind: "api-key", region: "eu-west-1" }, fetchImpl),
    ).resolves.toEqual({ apiRegion: "eu-central-1" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("routes a known OAuth profile from its ARN without a request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const credential: KiroManagementCredential = {
      accessToken: "oauth",
      kind: "oauth-desktop",
      profileArn: "arn:aws:codewhisperer:eu-central-1:123:profile/example",
    };
    await expect(resolveKiroManagementRoute(credential, fetchImpl)).resolves.toEqual({
      apiRegion: "eu-central-1",
      profileArn: credential.profileArn,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts a syntactically valid future profile region without treating seed regions as an allowlist", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const profileArn = "arn:aws:codewhisperer:ca-central-1:123:profile/example";
    await expect(
      resolveKiroManagementRoute({ accessToken: "oauth", kind: "oauth-idc", profileArn }, fetchImpl),
    ).resolves.toEqual({ apiRegion: "ca-central-1", profileArn });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects malformed profile ARNs and falls back to profile discovery", async () => {
    const profileArn = "arn:aws:codewhisperer:ca-central-1:123:profile/discovered";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ profiles: [{ arn: profileArn }] }));
    await expect(
      resolveKiroManagementRoute(
        {
          accessToken: "oauth",
          kind: "oauth-idc",
          profileArn: "arn:evil:not-codewhisperer:ca-central-1:123:anything",
          region: "us-east-1",
        },
        fetchImpl,
      ),
    ).resolves.toEqual({ apiRegion: "ca-central-1", profileArn });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("probes regions and derives the model route from ListAvailableProfiles", async () => {
    const profileArn = "arn:aws:codewhisperer:eu-central-1:123:profile/example";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ message: "forbidden" }, 403))
      .mockResolvedValueOnce(jsonResponse({ profiles: [{ arn: profileArn }] }));

    await expect(
      resolveKiroManagementRoute({ accessToken: "oauth", kind: "oauth-idc", region: "us-east-1" }, fetchImpl),
    ).resolves.toEqual({ apiRegion: "eu-central-1", profileArn });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://management.us-east-1.kiro.dev/");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://management.eu-central-1.kiro.dev/");
  });
});

describe("fetchKiroModelCatalog", () => {
  it("sends the Kiro CLI origin without a profile for API-key auth", async () => {
    process.env.KIRO_API_KEY = "configured-key";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(rawCatalog()));

    const catalog = await fetchKiroModelCatalog(undefined, fetchImpl);

    expect(catalog.models[0]?.modelId).toBe("gpt-5.6-sol");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://management.us-east-1.kiro.dev/");
    expect((init?.headers as Record<string, string>)["X-Amz-Target"]).toContain("ListAvailableModels");
    expect(JSON.parse(init?.body as string)).toEqual({ origin: "KIRO_CLI" });
  });

  it("uses the resolved OAuth profile and profile region for model discovery", async () => {
    const profileArn = "arn:aws:codewhisperer:eu-central-1:123:profile/example";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ profiles: [{ arn: profileArn }] }))
      .mockResolvedValueOnce(jsonResponse(rawCatalog()));

    const catalog = await fetchKiroModelCatalog("oauth-bearer", fetchImpl);

    expect(catalog.defaultModel.modelId).toBe("gpt-5.6-sol");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("https://management.eu-central-1.kiro.dev/");
    expect(JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string)).toEqual({
      origin: "KIRO_CLI",
      profileArn,
    });
  });

  it("rejects oversized response bodies while reading the stream", async () => {
    process.env.KIRO_API_KEY = "configured-key";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("x".repeat(1024 * 1024 + 1), { status: 200 }));
    await expect(fetchKiroModelCatalog(undefined, fetchImpl)).rejects.toThrow("invalid response size");
  });

  it("rejects unknown response fields instead of publishing a partial catalog", async () => {
    process.env.KIRO_API_KEY = "configured-key";
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ...rawCatalog(),
        profileArn: "must-not-be-accepted",
      }),
    );
    await expect(fetchKiroModelCatalog(undefined, fetchImpl)).rejects.toThrow("top-level.unknown-key");
  });
});
