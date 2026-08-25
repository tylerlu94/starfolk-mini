import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  ProcessResult,
  ProcessRunner,
} from "../process-runner.js";
import { buildSshArguments } from "./connection.js";
import {
  withTemporarySshIdentity,
  type SignalController,
  type SshIdentity,
} from "./identity.js";

const publicKey = `ssh-ed25519 ${"A".repeat(80)}`;

describe("SSH argument construction", () => {
  it("uses a private identity, isolated known_hosts, host checking, and a TTY", () => {
    const identity: SshIdentity = {
      knownHostsPath: "/private/tmp/key/known_hosts",
      privateKeyPath: "/private/tmp/key/id_ed25519",
      publicKey,
      temporaryDirectory: "/private/tmp/key",
    };
    expect(
      buildSshArguments(
        identity,
        { host: "ec2.example.com", port: 22, username: "ec2-user" },
        {
          interactive: true,
          remoteArguments: ["cd /workspace/repo && exec $SHELL -l"],
        },
      ),
    ).toEqual([
      "-tt",
      "-i",
      "/private/tmp/key/id_ed25519",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "UserKnownHostsFile=/private/tmp/key/known_hosts",
      "-p",
      "22",
      "ec2-user@ec2.example.com",
      "cd /workspace/repo && exec $SHELL -l",
    ]);
  });

  it("rejects connection fields that could become OpenSSH options", () => {
    const identity: SshIdentity = {
      knownHostsPath: "/tmp/known_hosts",
      privateKeyPath: "/tmp/key",
      publicKey,
      temporaryDirectory: "/tmp",
    };
    expect(() =>
      buildSshArguments(identity, { host: "-oProxyCommand=bad", port: 22, username: "ec2-user" }, {
        interactive: false,
        remoteArguments: [],
      }),
    ).toThrow(/unsafe SSH/u);
  });
});

describe("temporary SSH identity cleanup", () => {
  it("removes key material after success", async () => {
    const fixture = await identityFixture();
    let directory = "";
    await withTemporarySshIdentity(
      fixture.runner,
      async (identity) => {
        directory = identity.temporaryDirectory;
        await expect(access(identity.privateKeyPath)).resolves.toBeUndefined();
      },
      { signalController: fixture.signals, temporaryRoot: fixture.root },
    );
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes key material when the operation fails", async () => {
    const fixture = await identityFixture();
    let directory = "";
    await expect(
      withTemporarySshIdentity(
        fixture.runner,
        async (identity) => {
          directory = identity.temporaryDirectory;
          throw new Error("connection failed");
        },
        { signalController: fixture.signals, temporaryRoot: fixture.root },
      ),
    ).rejects.toThrow("connection failed");
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("synchronously removes key material on handled signals", async () => {
    const fixture = await identityFixture();
    let directory = "";
    await withTemporarySshIdentity(
      fixture.runner,
      async (identity) => {
        directory = identity.temporaryDirectory;
        fixture.signals.trigger("SIGTERM");
        await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
      },
      { signalController: fixture.signals, temporaryRoot: fixture.root },
    );
    expect(fixture.signals.terminated).toEqual(["SIGTERM"]);
  });
});

async function identityFixture() {
  const root = await mkdtemp(join(tmpdir(), "sfkm-identity-test-"));
  const signals = new FakeSignals();
  const runner: ProcessRunner = {
    async run(command, args) {
      expect(command).toBe("ssh-keygen");
      expect(args.slice(0, 6)).toEqual(["-q", "-t", "ed25519", "-N", "", "-f"]);
      const privatePath = args[6];
      if (privatePath === undefined) {
        throw new Error("Missing key path");
      }
      await writeFile(privatePath, "private-key", { mode: 0o600 });
      await writeFile(`${privatePath}.pub`, `${publicKey}\n`, { mode: 0o600 });
      return success();
    },
  };
  return { root, runner, signals };
}

class FakeSignals implements SignalController {
  readonly handlers = new Map<NodeJS.Signals, () => void>();
  readonly terminated: NodeJS.Signals[] = [];

  add(signal: NodeJS.Signals, handler: () => void): void {
    this.handlers.set(signal, handler);
  }

  remove(signal: NodeJS.Signals, handler: () => void): void {
    if (this.handlers.get(signal) === handler) {
      this.handlers.delete(signal);
    }
  }

  terminateAfterCleanup(signal: NodeJS.Signals): void {
    this.terminated.push(signal);
  }

  trigger(signal: NodeJS.Signals): void {
    this.handlers.get(signal)?.();
  }
}

function success(stdout = ""): ProcessResult {
  return { exitCode: 0, signal: null, stderr: "", stdout };
}
