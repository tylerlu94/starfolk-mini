import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HOSTED_API_URL, loadConfig, normalizeApiUrl } from "./config.js";

describe("loadConfig", () => {
  it("returns an actionable error when the file is missing", async () => {
    await expect(
      loadConfig({ configPath: join(tmpdir(), "sfkm-does-not-exist", "config.json") }),
    ).rejects.toMatchObject({ code: "CONFIG_NOT_FOUND" });
  });

  it("rejects group- or world-accessible configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sfkm-config-test-"));
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ apiToken: "secret" }), { mode: 0o644 });
    await chmod(path, 0o644);

    await expect(
      loadConfig({ configPath: path, environment: { SFKM_API_URL: "http://localhost:3000" } }),
    ).rejects.toMatchObject({ code: "CONFIG_UNSAFE" });
  });

  it("rejects a symlink even when its target is private", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sfkm-config-test-"));
    const target = join(directory, "target.json");
    const path = join(directory, "config.json");
    await writeFile(target, JSON.stringify({ apiToken: "secret" }), { mode: 0o600 });
    await symlink(target, path);

    await expect(
      loadConfig({ configPath: path, environment: { SFKM_API_URL: "http://localhost:3000" } }),
    ).rejects.toMatchObject({ code: "CONFIG_UNSAFE" });
  });

  it("loads a private file and the development URL override", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sfkm-config-test-"));
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ apiToken: "secret" }), { mode: 0o600 });
    await chmod(path, 0o600);

    await expect(
      loadConfig({ configPath: path, environment: { SFKM_API_URL: "http://localhost:3000/" } }),
    ).resolves.toEqual({ apiToken: "secret", apiUrl: "http://localhost:3000" });
  });

  it("uses the fixed hosted API URL without an environment override", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sfkm-config-test-"));
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ apiToken: "secret" }), { mode: 0o600 });

    await expect(loadConfig({ configPath: path, environment: {} })).resolves.toEqual({
      apiToken: "secret",
      apiUrl: "https://sfkm-backend-production.up.railway.app",
    });
    expect(HOSTED_API_URL).toBe("https://sfkm-backend-production.up.railway.app");
  });
});

describe("normalizeApiUrl", () => {
  it("rejects credentials, query strings, fragments, and non-HTTP schemes", () => {
    expect(() => normalizeApiUrl("https://user:pass@example.com")).toThrow();
    expect(() => normalizeApiUrl("https://example.com?a=1")).toThrow();
    expect(() => normalizeApiUrl("https://example.com/#x")).toThrow();
    expect(() => normalizeApiUrl("file:///tmp/api")).toThrow();
  });
});
