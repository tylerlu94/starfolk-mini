import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { RuntimeError } from "./errors.js";
import { writePrivateFile } from "./io.js";

import type { CallbackClient } from "./callbacks.js";
import type { ProcessRunner } from "./processes.js";
import type { BootstrapInput } from "./schemas.js";

export interface BootstrapOptions {
  readonly callbacks: CallbackClient;
  readonly gitExecutable: string;
  readonly now?: () => Date;
  readonly processes: ProcessRunner;
  readonly repositoryPath: string;
}

export interface BootstrapResult {
  readonly commitSha: string;
  readonly status: "READY";
}

export async function bootstrapRepository(
  input: BootstrapInput,
  options: BootstrapOptions,
): Promise<BootstrapResult> {
  const now = options.now ?? (() => new Date());
  try {
    await cloneExactCommit(input, options);
    await runSetupCommand(input.setupCommand, options);
  } catch {
    await options.callbacks.postDevboxStatus(input.callbackUrl, input.bootstrapToken, {
      occurredAt: now().toISOString(),
      reason: "Repository bootstrap failed.",
      status: "FAILED",
    });
    throw new RuntimeError("BOOTSTRAP_FAILED", "Repository bootstrap failed.");
  }

  await options.callbacks.postDevboxStatus(input.callbackUrl, input.bootstrapToken, {
    occurredAt: now().toISOString(),
    status: "READY",
  });
  return { commitSha: input.repository.commitSha.toLowerCase(), status: "READY" };
}

async function cloneExactCommit(
  input: BootstrapInput,
  options: BootstrapOptions,
): Promise<void> {
  if (await pathExists(options.repositoryPath)) {
    throw new RuntimeError("REPOSITORY_EXISTS", "The repository destination already exists.");
  }

  await mkdir(dirname(options.repositoryPath), { mode: 0o700, recursive: true });
  await mkdir(options.repositoryPath, { mode: 0o700 });

  await requireSuccess(
    options.processes.run(options.gitExecutable, ["-C", options.repositoryPath, "init", "--quiet"]),
    "Git initialization failed.",
  );

  const configPath = `${options.repositoryPath}/.git/config`;
  const remoteRef = "refs/remotes/origin/sfkm-target";
  const config = [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tfilemode = true",
    "\tbare = false",
    "\tlogallrefupdates = true",
    '[remote "origin"]',
    `\turl = "${escapeGitConfigValue(input.repository.url)}"`,
    `\tfetch = +refs/heads/${input.repository.branch}:${remoteRef}`,
    "",
  ].join("\n");
  await writePrivateFile(configPath, config, "w");

  await requireSuccess(
    options.processes.run(
      options.gitExecutable,
      ["-C", options.repositoryPath, "fetch", "origin"],
      { stderr: "inherit", stdout: "inherit" },
    ),
    "Git fetch failed.",
  );

  const targetRef = "refs/sfkm/target";
  const targetRefDirectory = `${options.repositoryPath}/.git/refs/sfkm`;
  await mkdir(targetRefDirectory, { mode: 0o700, recursive: true });
  await writePrivateFile(
    `${targetRefDirectory}/target`,
    `${input.repository.commitSha.toLowerCase()}\n`,
  );
  await requireSuccess(
    options.processes.run(options.gitExecutable, [
      "-C",
      options.repositoryPath,
      "merge-base",
      "--is-ancestor",
      targetRef,
      remoteRef,
    ]),
    "The requested commit is not reachable from the requested branch.",
  );

  await requireSuccess(
    options.processes.run(options.gitExecutable, [
      "-C",
      options.repositoryPath,
      "checkout",
      "--quiet",
      "--detach",
      targetRef,
    ]),
    "Git checkout failed.",
  );

  const checkedOutCommit = await requireSuccess(
    options.processes.run(options.gitExecutable, [
      "-C",
      options.repositoryPath,
      "rev-parse",
      "HEAD",
    ]),
    "Unable to verify the checked out commit.",
  );
  if (checkedOutCommit.stdout.trim().toLowerCase() !== input.repository.commitSha.toLowerCase()) {
    throw new RuntimeError("COMMIT_MISMATCH", "The checked out commit does not match the request.");
  }
}

async function runSetupCommand(
  command: string,
  options: BootstrapOptions,
): Promise<void> {
  const [executable, ...arguments_] = parseCommandArguments(command);
  if (executable === undefined) {
    throw new RuntimeError("INVALID_SETUP_COMMAND", "The setup command is empty.");
  }
  await requireSuccess(
    options.processes.run(executable, arguments_, {
      cwd: options.repositoryPath,
      stderr: "inherit",
      stdout: "inherit",
    }),
    "The repository setup command failed.",
  );
}

export function parseCommandArguments(command: string): string[] {
  const arguments_: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;

  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        arguments_.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }

  if (escaped || quote !== null) {
    throw new RuntimeError("INVALID_SETUP_COMMAND", "The setup command has invalid quoting.");
  }
  if (started) {
    arguments_.push(current);
  }
  return arguments_;
}

function escapeGitConfigValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function requireSuccess(
  resultPromise: ReturnType<ProcessRunner["run"]>,
  message: string,
) {
  const result = await resultPromise;
  if (result.exitCode !== 0) {
    throw new RuntimeError("PROCESS_FAILED", message);
  }
  return result;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
