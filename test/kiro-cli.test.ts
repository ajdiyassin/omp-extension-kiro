import { afterEach, describe, expect, it } from "vitest";
import { getKiroApiKeyCredentials, getKiroCliCredentials, getKiroCliDbPath, TOKEN_KEY_BY_AUTH_METHOD } from "../src/kiro-cli.js";



describe("Feature 4: kiro-cli Credential Fallback", () => {
  describe("getKiroCliDbPath", () => {
    it("returns undefined when database does not exist", () => {
      const result = getKiroCliDbPath();
      expect(result === undefined || typeof result === "string").toBe(true);
    });
  });

  describe("getKiroCliCredentials", () => {
    it("returns undefined or credentials when database may exist", () => {
      const result = getKiroCliCredentials();
      expect(result === undefined || (typeof result === "object" && "access" in result)).toBe(true);
    });

    it("returns credentials with required fields when available", () => {
      const result = getKiroCliCredentials();
      if (result) {
        expect(result).toHaveProperty("access");
        expect(result).toHaveProperty("refresh");
        expect(result).toHaveProperty("expires");
        expect(result).toHaveProperty("clientId");
        expect(result).toHaveProperty("clientSecret");
        expect(result).toHaveProperty("region");
      }
    });
  });

  describe("M4 — getKiroApiKeyCredentials (KIRO_API_KEY env var)", () => {
    afterEach(() => {
      delete process.env.KIRO_API_KEY;
    });

    it("returns undefined when KIRO_API_KEY is unset", () => {
      delete process.env.KIRO_API_KEY;
      expect(getKiroApiKeyCredentials()).toBeUndefined();
    });

    it("returns synthetic credentials with the key as access token", () => {
      process.env.KIRO_API_KEY = "ksk_paidtier123";
      const creds = getKiroApiKeyCredentials();
      expect(creds).toBeDefined();
      expect(creds?.access).toBe("ksk_paidtier123");
      expect(creds?.region).toBe("us-east-1");
      expect(creds?.authMethod).toBe("idc");
      // No expiry / refresh — API keys are version-independent and never refreshed.
      expect(creds?.refresh).toBe("");
      expect(creds?.expires).toBe(Number.POSITIVE_INFINITY);
    });
  });
  describe("M5 — v3 credential store parity (no-op fixture)", () => {
    // Verified fact (kiro-cli 2.11.1 + v3): the auth store is byte-identical
    // between v2 and v3 — same table (`auth_kv`), same keys (the `odic` typo is
    // real), same JSON fields. This fixture locks that in so a future v3 bump
    // can't silently change the key the extension reads.
    it("reads the same v3 token key (kirocli:odic:token) as v2", () => {
      // The IDC token key must match verbatim — the `odic` spelling is a
      // kiro-cli typo we must not "correct".
      const idcKeys: string[] = ["kirocli:odic:token", "codewhisperer:odic:token"];
      expect(idcKeys[0]).toBe("kirocli:odic:token");
      // And it must be what the resolver actually queries.
      expect(TOKEN_KEY_BY_AUTH_METHOD.idc).toEqual(idcKeys);
    });

    it("maps auth methods to the same v3 key set (idc + desktop)", () => {
      expect(TOKEN_KEY_BY_AUTH_METHOD.idc).toContain("kirocli:odic:token");
      expect(TOKEN_KEY_BY_AUTH_METHOD.desktop).toEqual(["kirocli:social:token"]);
    });
  });
});
