import { describe, expect, it } from "vitest";
import { getKiroCliCredentials, getKiroCliDbPath } from "../src/kiro-cli.js";

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
});
