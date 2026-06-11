import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Build output validation", () => {
  const distPath = "dist/index.js";

  it("dist/index.js exists", () => {
    expect(existsSync(distPath)).toBe(true);
  });

  it("has no @earendil-works imports", () => {
    const content = readFileSync(distPath, "utf-8");
    expect(content).not.toContain("@earendil-works");
  });

  it("has no @oh-my-pi/pi-tui imports", () => {
    const content = readFileSync(distPath, "utf-8");
    expect(content).not.toContain("@oh-my-pi/pi-tui");
  });

  it("has no @oh-my-pi/pi-coding-agent imports", () => {
    const content = readFileSync(distPath, "utf-8");
    expect(content).not.toContain("@oh-my-pi/pi-coding-agent");
  });

  it("has no @oh-my-pi/pi-natives imports", () => {
    const content = readFileSync(distPath, "utf-8");
    expect(content).not.toContain("@oh-my-pi/pi-natives");
  });

  it("has no bare @oh-my-pi/pi-ai import (should be bundled inline)", () => {
    const content = readFileSync(distPath, "utf-8");
    expect(content).not.toMatch(/from ["']@oh-my-pi\/pi-ai["']/);
  });

  it("has no obsolete kiro-cli debug refresh command", () => {
    const content = readFileSync(distPath, "utf-8");
    expect(content).not.toContain("debug refresh-auth-token");
    expect(content).not.toContain("refreshViaKiroCli");
  });

  it("only imports Node built-ins", () => {
    const content = readFileSync(distPath, "utf-8");
    const importLines = content.match(/^import .+ from ["'][^"']+["']/gm) || [];
    for (const line of importLines) {
      const match = line.match(/from ["']([^"']+)["']/);
      if (match) {
        expect(match[1]).toMatch(/^node:/);
      }
    }
  });
});
