import { CreateDevboxRequestSchema, type RepositoryReference } from "@sfkm/contracts";

import { CliError } from "../errors.js";
import type { ProcessRunner } from "../process-runner.js";

const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
const GITHUB_HTTPS_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

export async function preflightRepository(
  runner: ProcessRunner,
  rawUrl: string,
  branch: string,
): Promise<RepositoryReference> {
  const url = normalizePublicGitHubUrl(rawUrl);
  if (!isSafeBranch(branch)) {
    throw new CliError("REPO_BRANCH_INVALID", "The requested Git branch name is not supported.");
  }
  const remoteRef = `refs/heads/${branch}`;
  const remoteHead = await runGit(runner, [
    "-c",
    "credential.helper=",
    "-c",
    "core.askPass=",
    "ls-remote",
    "--exit-code",
    "--refs",
    url,
    remoteRef,
  ]);
  if (remoteHead.exitCode !== 0) {
    throw new CliError(
      "REPO_NOT_FOUND",
      "The requested branch is not anonymously readable. Verify that the GitHub repository is public and the branch exists.",
    );
  }
  const lines = remoteHead.stdout.trim().split(/\r?\n/u);
  const columns = lines[0]?.trim().split(/\s+/u);
  const commitSha = columns?.[0]?.toLowerCase();
  if (
    lines.length !== 1 ||
    columns?.length !== 2 ||
    columns[1] !== remoteRef ||
    commitSha === undefined ||
    !/^[0-9a-f]{40}$/u.test(commitSha)
  ) {
    throw new CliError("REPO_INVALID", "GitHub returned invalid repository metadata.");
  }

  const parsed = CreateDevboxRequestSchema.shape.repository.safeParse({
    branch,
    commitSha,
    url,
  });
  if (!parsed.success) {
    throw new CliError("REPO_INVALID", "Repository metadata does not match the API contract.");
  }
  return parsed.data;
}

export function normalizePublicGitHubUrl(value: string): string {
  const match = GITHUB_HTTPS_PATTERN.exec(value);
  const owner = match?.[1];
  const repository = match?.[2];
  if (
    owner === undefined ||
    repository === undefined ||
    owner === "." ||
    owner === ".." ||
    repository === "." ||
    repository === ".."
  ) {
    throw new CliError(
      "REPO_ORIGIN_INVALID",
      "Git origin must be a public GitHub HTTPS URL such as https://github.com/owner/repository.git.",
    );
  }
  return `https://github.com/${owner}/${repository}.git`;
}

async function runGit(
  runner: ProcessRunner,
  args: readonly string[],
) {
  return runner.run("git", args, {
    environment: { GIT_TERMINAL_PROMPT: "0" },
    maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
  });
}

function isSafeBranch(value: string): boolean {
  return (
    /^[a-z0-9][a-z0-9._/-]{0,254}$/iu.test(value) &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !/[ ~^:?*[\\]/u.test(value)
  );
}
