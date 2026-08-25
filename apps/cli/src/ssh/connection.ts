import type { AuthorizeSshKeyResponse } from "@sfkm/contracts";

import { CliError } from "../errors.js";
import type { ProcessResult, ProcessRunner } from "../process-runner.js";
import type { SshIdentity } from "./identity.js";

const SAFE_HOST_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|(?:\d{1,3}\.){3}\d{1,3})$/u;
const SAFE_USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/u;

export interface SshInvocation {
  readonly interactive: boolean;
  readonly remoteArguments: readonly string[];
  readonly stdin?: string;
}

export function buildSshArguments(
  identity: SshIdentity,
  authorization: AuthorizeSshKeyResponse,
  invocation: SshInvocation,
): string[] {
  validateAuthorization(authorization);
  return [
    invocation.interactive ? "-tt" : "-T",
    "-i",
    identity.privateKeyPath,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${identity.knownHostsPath}`,
    "-p",
    authorization.port.toString(10),
    `${authorization.username}@${authorization.host}`,
    ...invocation.remoteArguments,
  ];
}

export async function runSsh(
  runner: ProcessRunner,
  identity: SshIdentity,
  authorization: AuthorizeSshKeyResponse,
  invocation: SshInvocation,
): Promise<ProcessResult> {
  return runner.run("ssh", buildSshArguments(identity, authorization, invocation), {
    interactive: invocation.interactive,
    maxOutputBytes: 256 * 1024,
    ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
  });
}

function validateAuthorization(authorization: AuthorizeSshKeyResponse): void {
  if (
    !SAFE_HOST_PATTERN.test(authorization.host) ||
    authorization.host.startsWith("-") ||
    !SAFE_USERNAME_PATTERN.test(authorization.username)
  ) {
    throw new CliError(
      "INVALID_API_RESPONSE",
      "The SFKM API returned unsafe SSH connection details.",
    );
  }
}
