import { describe, expect, it } from "vitest";

import type {
  ProcessResult,
  ProcessRunner,
} from "../process-runner.js";
import { normalizePublicGitHubUrl, preflightRepository } from "./preflight.js";

const sha = "1234567890abcdef1234567890abcdef12345678";

describe("repository preflight", () => {
  it("resolves an anonymously readable public GitHub branch", async () => {
    const runner = new SequenceRunner([success(`${sha}\trefs/heads/main\n`)]);

    await expect(
      preflightRepository(runner, "https://github.com/openai/example", "main"),
    ).resolves.toEqual({
      branch: "main",
      commitSha: sha,
      url: "https://github.com/openai/example.git",
    });
    expect(runner.calls[0]?.args).toEqual([
      "-c",
      "credential.helper=",
      "-c",
      "core.askPass=",
      "ls-remote",
      "--exit-code",
      "--refs",
      "https://github.com/openai/example.git",
      "refs/heads/main",
    ]);
  });

  it("rejects a missing or private repository branch", async () => {
    await expect(
      preflightRepository(
        new SequenceRunner([failure()]),
        "https://github.com/openai/example.git",
        "main",
      ),
    ).rejects.toMatchObject({ code: "REPO_NOT_FOUND" });
  });

  it("rejects unsafe branches before contacting GitHub", async () => {
    const runner = new SequenceRunner([]);
    await expect(
      preflightRepository(runner, "https://github.com/openai/example.git", "main;rm"),
    ).rejects.toMatchObject({ code: "REPO_BRANCH_INVALID" });
    expect(runner.calls).toEqual([]);
  });

  it("rejects malformed remote metadata", async () => {
    await expect(
      preflightRepository(
        new SequenceRunner([success(`short\trefs/heads/main\n`)]),
        "https://github.com/openai/example.git",
        "main",
      ),
    ).rejects.toMatchObject({ code: "REPO_INVALID" });
  });

  it("normalizes an HTTPS GitHub URL and rejects lookalike hosts", () => {
    expect(normalizePublicGitHubUrl("https://github.com/openai/example")).toBe(
      "https://github.com/openai/example.git",
    );
    expect(() => normalizePublicGitHubUrl("https://github.com.evil.test/a/b.git")).toThrow();
    expect(() => normalizePublicGitHubUrl("https://github.com/a/b.git?token=x")).toThrow();
  });
});

class SequenceRunner implements ProcessRunner {
  readonly calls: Array<{ args: readonly string[]; command: string }> = [];

  constructor(private readonly results: ProcessResult[]) {}

  async run(command: string, args: readonly string[]) {
    this.calls.push({ args, command });
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error("Unexpected process call");
    }
    return result;
  }
}

function success(stdout: string): ProcessResult {
  return { exitCode: 0, signal: null, stderr: "", stdout };
}

function failure(): ProcessResult {
  return { exitCode: 1, signal: null, stderr: "not exposed", stdout: "" };
}
