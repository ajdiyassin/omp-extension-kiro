import { describe, expect, it, vi } from "vitest";
import type { KiroCredentials } from "../src/oauth.js";
import { refreshKiroToken } from "../src/oauth.js";

// Mock kiro-cli to prevent fallback to real credentials
vi.mock("../src/kiro-cli.js", () => ({
  getKiroCliCredentials: vi.fn(() => undefined),
  getKiroCliCredentialsAllowExpired: vi.fn(() => undefined),
  getKiroCliSocialToken: vi.fn(() => undefined),
  getKiroCliSocialTokenAllowExpired: vi.fn(() => undefined),
  saveKiroCliCredentials: vi.fn(),
}));

describe("Feature 3: OAuth — Token Refresh", () => {
  describe("refreshKiroToken", () => {
    it("refreshes token using encoded refresh field", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "new_at", refreshToken: "new_rt", expiresIn: 3600 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const creds = await refreshKiroToken({
        refresh: "old_rt|cid|csec|idc",
        access: "old_at",
        expires: 0,
        region: "us-east-1",
      } as KiroCredentials);
      expect(creds.access).toBe("new_at");
      expect(creds.refresh).toContain("new_rt|cid|csec|idc");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.clientId).toBe("cid");
      expect(body.refreshToken).toBe("old_rt");
      vi.unstubAllGlobals();
    });

    it("throws on failed refresh (all regions fail)", async () => {
      // Persistent 401 so every probed region fails
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
      await expect(refreshKiroToken({ refresh: "rt|c|s|idc", access: "x", expires: 0 })).rejects.toThrow();
      vi.unstubAllGlobals();
    });

    it("refreshes desktop tokens via Kiro auth service", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "desk_at", expiresIn: 3600 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const creds = await refreshKiroToken({
        refresh: "desk_rt|desktop",
        access: "old",
        expires: 0,
        region: "us-east-1",
      } as KiroCredentials);
      expect(creds.access).toBe("desk_at");
      expect(creds.refresh).toContain("desk_rt|desktop");
      expect((creds as KiroCredentials).authMethod).toBe("desktop");

      const url = mockFetch.mock.calls[0][0];
      expect(url).toContain("auth.desktop.kiro.dev/refreshToken");
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.refreshToken).toBe("desk_rt");
      expect(body.clientId).toBeUndefined();
      vi.unstubAllGlobals();
    });

    it("throws on desktop token refresh failure (all regions fail)", async () => {
      // Persistent 401 so every probed region fails
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
      await expect(
        refreshKiroToken({
          refresh: "desk_rt|desktop",
          access: "old",
          expires: 0,
          region: "us-east-1",
        } as KiroCredentials),
      ).rejects.toThrow("Desktop token refresh failed: 401");
      vi.unstubAllGlobals();
    });

    it("throws on desktop token refresh with missing accessToken (all regions)", async () => {
      // Persistent response with no accessToken so every probed region fails
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ expiresIn: 3600 }) }),
      );
      await expect(
        refreshKiroToken({
          refresh: "desk_rt|desktop",
          access: "old",
          expires: 0,
          region: "us-east-1",
        } as KiroCredentials),
      ).rejects.toThrow("Desktop token refresh: missing accessToken");
      vi.unstubAllGlobals();
    });

    it("uses region from credentials for IDC refresh (tries it first)", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: "new_at", refreshToken: "new_rt", expiresIn: 3600 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await refreshKiroToken({
        refresh: "old_rt|cid|csec|idc",
        access: "old_at",
        expires: 0,
        region: "us-west-2",
      } as KiroCredentials);

      expect(mockFetch.mock.calls[0][0]).toContain("oidc.us-west-2.amazonaws.com");
      vi.unstubAllGlobals();
    });

    it("uses expired kiro-cli creds as fallback when direct refresh fails", async () => {
      const { getKiroCliCredentialsAllowExpired } = await import("../src/kiro-cli.js");
      vi.mocked(getKiroCliCredentialsAllowExpired).mockReturnValueOnce({
        refresh: "cli_rt|cli_cid|cli_csec|idc",
        access: "cli_at",
        expires: Date.now() - 1000,
        clientId: "cli_cid",
        clientSecret: "cli_csec",
        region: "us-east-1",
        authMethod: "idc",
      });

      // Fail all probes for the original token, succeed for cli token (matched by refreshToken)
      const mockFetch = vi.fn().mockImplementation(async (_url: string, options: RequestInit) => {
        const body = JSON.parse(options.body as string);
        if (body.refreshToken === "cli_rt") {
          return { ok: true, json: () => Promise.resolve({ accessToken: "new_at", refreshToken: "new_rt", expiresIn: 3600 }) };
        }
        return { ok: false, status: 401 };
      });
      vi.stubGlobal("fetch", mockFetch);

      const creds = await refreshKiroToken({ refresh: "stale_rt|cid|csec|idc", access: "stale_at", expires: 0 });
      expect(creds.access).toBe("new_at");
      vi.unstubAllGlobals();
    });

    it("falls through to graceful degradation when expired creds refresh also fails", async () => {
      const { getKiroCliCredentialsAllowExpired } = await import("../src/kiro-cli.js");
      vi.mocked(getKiroCliCredentialsAllowExpired).mockReturnValueOnce({
        refresh: "cli_rt|cli_cid|cli_csec|idc",
        access: "cli_at",
        expires: Date.now() - 1000,
        clientId: "cli_cid",
        clientSecret: "cli_csec",
        region: "us-east-1",
        authMethod: "idc",
      });

      // All probes fail for both token sets
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

      const creds = await refreshKiroToken({
        refresh: "old_rt|cid|csec|idc",
        access: "old_at",
        expires: Date.now() - 60_000,
      });
      expect(creds.access).toBe("old_at");
      expect(creds.expires).toBeGreaterThan(Date.now());
      vi.unstubAllGlobals();
    });

    // --- New tests ---

    it("IDC refresh derives region from profileArn when region is missing", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ accessToken: "new_at", refreshToken: "new_rt", expiresIn: 3600 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const creds = await refreshKiroToken({
        refresh: "old_rt|cid|csec|idc",
        access: "old_at",
        expires: 0,
        clientId: "cid",
        clientSecret: "csec",
        profileArn: "arn:aws:codewhisperer:eu-central-1:123:profile/test",
      } as KiroCredentials);

      expect(creds.access).toBe("new_at");
      expect((creds as KiroCredentials).region).toBe("eu-central-1");
      expect(mockFetch.mock.calls[0][0]).toContain("oidc.eu-central-1.amazonaws.com");
      vi.unstubAllGlobals();
    });

    it("tries next region when first IDC candidate fails", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 400 }) // first candidate fails
        .mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ accessToken: "new_at", refreshToken: "new_rt", expiresIn: 3600 }),
        });
      vi.stubGlobal("fetch", mockFetch);

      // No region or profileArn → first candidate is eu-central-1
      const creds = await refreshKiroToken({
        refresh: "old_rt|cid|csec|idc",
        access: "old_at",
        expires: 0,
      } as KiroCredentials);

      expect(creds.access).toBe("new_at");
      expect(mockFetch).toHaveBeenCalledTimes(2);
      vi.unstubAllGlobals();
    });

    it("refreshed IDC credential carries the successful region", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ accessToken: "at", refreshToken: "rt", expiresIn: 3600 }),
      }));

      const creds = await refreshKiroToken({
        refresh: "old_rt|cid|csec|idc",
        access: "old",
        expires: 0,
        clientId: "cid",
        clientSecret: "csec",
        region: "eu-central-1",
      } as KiroCredentials);

      expect((creds as KiroCredentials).region).toBe("eu-central-1");
      vi.unstubAllGlobals();
    });
  });
});
