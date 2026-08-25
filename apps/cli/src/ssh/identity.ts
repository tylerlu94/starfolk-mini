import { chmod, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthorizeSshKeyRequestSchema } from "@sfkm/contracts";

import { CliError } from "../errors.js";
import {
  requireSuccessfulProcess,
  type ProcessRunner,
} from "../process-runner.js";

const PUBLIC_KEY_MAX_BYTES = 16 * 1024;
const HANDLED_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

export interface SshIdentity {
  readonly knownHostsPath: string;
  readonly privateKeyPath: string;
  readonly publicKey: string;
  readonly temporaryDirectory: string;
}

export interface SignalController {
  add(signal: NodeJS.Signals, handler: () => void): void;
  remove(signal: NodeJS.Signals, handler: () => void): void;
  terminateAfterCleanup(signal: NodeJS.Signals): void;
}

export const processSignalController: SignalController = {
  add: (signal, handler) => process.on(signal, handler),
  remove: (signal, handler) => process.off(signal, handler),
  terminateAfterCleanup: (signal) => process.kill(process.pid, signal),
};

export interface TemporaryIdentityOptions {
  readonly signalController?: SignalController;
  readonly temporaryRoot?: string;
}

export async function withTemporarySshIdentity<T>(
  runner: ProcessRunner,
  operation: (identity: SshIdentity) => Promise<T>,
  options: TemporaryIdentityOptions = {},
): Promise<T> {
  const directory = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), "sfkm-ssh-"));
  await chmod(directory, 0o700);
  const signalController = options.signalController ?? processSignalController;
  let cleaned = false;
  const cleanupSync = (): void => {
    if (!cleaned) {
      cleaned = true;
      rmSync(directory, { force: true, recursive: true });
    }
  };
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of HANDLED_SIGNALS) {
    const handler = (): void => {
      cleanupSync();
      for (const [registeredSignal, registeredHandler] of handlers) {
        signalController.remove(registeredSignal, registeredHandler);
      }
      signalController.terminateAfterCleanup(signal);
    };
    handlers.set(signal, handler);
    signalController.add(signal, handler);
  }

  try {
    const privateKeyPath = join(directory, "id_ed25519");
    const keygen = await runner.run(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-f", privateKeyPath],
      { maxOutputBytes: 64 * 1024 },
    );
    requireSuccessfulProcess(
      "ssh-keygen",
      keygen,
      "SSH_KEYGEN_FAILED",
      "Unable to generate the temporary Ed25519 SSH key.",
    );
    await chmod(privateKeyPath, 0o600);

    const publicKeyPath = `${privateKeyPath}.pub`;
    const publicKeyMetadata = await stat(publicKeyPath);
    if (!publicKeyMetadata.isFile() || publicKeyMetadata.size > PUBLIC_KEY_MAX_BYTES) {
      throw new CliError("SSH_KEYGEN_FAILED", "ssh-keygen produced an invalid public key file.");
    }
    const publicKey = readSingleLine(await readFile(publicKeyPath, "utf8"));
    if (!AuthorizeSshKeyRequestSchema.safeParse({ publicKey }).success) {
      throw new CliError("SSH_KEYGEN_FAILED", "ssh-keygen produced an invalid Ed25519 public key.");
    }

    const knownHostsPath = join(directory, "known_hosts");
    const knownHosts = await open(knownHostsPath, "wx", 0o600);
    await knownHosts.close();

    return await operation({
      knownHostsPath,
      privateKeyPath,
      publicKey,
      temporaryDirectory: directory,
    });
  } finally {
    for (const [signal, handler] of handlers) {
      signalController.remove(signal, handler);
    }
    if (!cleaned) {
      cleaned = true;
      await rm(directory, { force: true, recursive: true });
    }
  }
}

function readSingleLine(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new CliError("SSH_KEYGEN_FAILED", "ssh-keygen produced an invalid public key.");
  }
  return trimmed;
}
