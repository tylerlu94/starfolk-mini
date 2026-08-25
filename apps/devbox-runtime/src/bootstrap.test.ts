import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { bootstrapRepository, parseCommandArguments } from "./bootstrap.js";
import { HttpCallbackClient } from "./callbacks.js";
import { BootstrapInputSchema } from "./schemas.js";
import { startFakeCallbackServer } from "./test-support.js";

import type {
  ProcessResult,
  ProcessRunner,
  RunProcessOptions,
} from "./processes.js";
import type { FakeCallbackServer } from "./test-support.js";

const devboxId = "devbox_2f1c9de0-f296-4e5d-9aaa-92d945e94ea2";
const commitSha = "0123456789abcdef0123456789abcdef01234567";
const token = "b".repeat(64);

class FakeProcesses implements ProcessRunner {
  readonly calls: Array<{
    arguments_: readonly string[];
    executable: string;
    options: RunProcessOptions | undefined;
  }> = [];
  checkoutCommit = commitSha;
  setupExitCode = 0;

  async run(
    executable: string,
    arguments_: readonly string[],
    options?: RunProcessOptions,
  ): Promise<ProcessResult> {
    this.calls.push({ arguments_, executable, options });
    const gitDirectoryIndex = arguments_.indexOf("-C");
    const repositoryPath =
      gitDirectoryIndex === -1 ? undefined : arguments_[gitDirectoryIndex + 1];
    if (arguments_.includes("init") && repositoryPath !== undefined) {
      await mkdir(join(repositoryPath, ".git"), { recursive: true });
    }
    const isRevParse = arguments_.includes("rev-parse");
    return {
      exitCode: executable === "npm" ? this.setupExitCode : 0,
      stderr: "",
      stdout: isRevParse ? `${this.checkoutCommit}\n` : "",
    };
  }
}

const servers: FakeCallbackServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe("bootstrap", () => {
  it("fetches and verifies the exact branch commit without shell interpolation", async () => {
    const server = await startFakeCallbackServer();
    servers.push(server);
    const repositoryPath = join(process.env.TMPDIR ?? "/tmp", `sfkm-bootstrap-${crypto.randomUUID()}`);
    const processes = new FakeProcesses();
    const input = BootstrapInputSchema.parse({
      bootstrapToken: token,
      callbackUrl: server.url,
      devboxId,
      repository: {
        branch: "feature/safe",
        commitSha,
        url: "https://example.test/public-repo.git",
      },
      setupCommand: 'npm ci --cache "cache directory"',
    });

    await expect(
      bootstrapRepository(input, {
        callbacks: new HttpCallbackClient(server.fetch),
        gitExecutable: "git",
        processes,
        repositoryPath,
      }),
    ).resolves.toEqual({ commitSha, status: "READY" });

    const config = await readFile(join(repositoryPath, ".git/config"), "utf8");
    expect(config).toContain('url = "https://example.test/public-repo.git"');
    expect(config).toContain(
      "fetch = +refs/heads/feature/safe:refs/remotes/origin/sfkm-target",
    );
    expect(processes.calls.at(-1)).toMatchObject({
      arguments_: ["ci", "--cache", "cache directory"],
      executable: "npm",
      options: { cwd: repositoryPath },
    });
    const serializedGitArguments = JSON.stringify(
      processes.calls.filter((call) => call.executable === "git").map((call) => call.arguments_),
    );
    expect(serializedGitArguments).not.toContain(input.repository.url);
    expect(serializedGitArguments).not.toContain(input.repository.branch);
    expect(serializedGitArguments).not.toContain(commitSha);
    expect(server.requests).toEqual([
      {
        authorization: `Bearer ${token}`,
        body: expect.objectContaining({ status: "READY" }),
      },
    ]);
  });

  it("reports FAILED when the fetched branch does not match the requested SHA", async () => {
    const server = await startFakeCallbackServer();
    servers.push(server);
    const processes = new FakeProcesses();
    processes.checkoutCommit = "f".repeat(40);
    const input = BootstrapInputSchema.parse({
      bootstrapToken: token,
      callbackUrl: server.url,
      devboxId,
      repository: {
        branch: "main",
        commitSha,
        url: "https://example.test/public-repo.git",
      },
      setupCommand: "npm ci",
    });

    await expect(
      bootstrapRepository(input, {
        callbacks: new HttpCallbackClient(server.fetch),
        gitExecutable: "git",
        processes,
        repositoryPath: join(process.env.TMPDIR ?? "/tmp", `sfkm-bootstrap-${crypto.randomUUID()}`),
      }),
    ).rejects.toThrow("Repository bootstrap failed");
    expect(server.requests[0]?.body).toEqual(expect.objectContaining({ status: "FAILED" }));
  });

  it("fails safely when the callback server rejects READY", async () => {
    const server = await startFakeCallbackServer(() => 503);
    servers.push(server);
    const input = BootstrapInputSchema.parse({
      bootstrapToken: token,
      callbackUrl: server.url,
      devboxId,
      repository: {
        branch: "main",
        commitSha,
        url: "https://example.test/public-repo.git",
      },
      setupCommand: "npm ci",
    });

    await expect(
      bootstrapRepository(input, {
        callbacks: new HttpCallbackClient(server.fetch),
        gitExecutable: "git",
        processes: new FakeProcesses(),
        repositoryPath: join(process.env.TMPDIR ?? "/tmp", `sfkm-bootstrap-${crypto.randomUUID()}`),
      }),
    ).rejects.toThrow("callback was rejected");
  });
});

describe("setup command parsing", () => {
  it("creates an argument array without evaluating shell syntax", () => {
    expect(parseCommandArguments("npm run test;touch /tmp/not-executed")).toEqual([
      "npm",
      "run",
      "test;touch",
      "/tmp/not-executed",
    ]);
    expect(() => parseCommandArguments("npm 'unterminated")).toThrow("invalid quoting");
  });
});
