#!/usr/bin/env node

import { ApiClient } from "./api-client.js";
import { CliService } from "./cli-service.js";
import { loadConfig } from "./config.js";
import { toCliError } from "./errors.js";
import { SpawnProcessRunner } from "./process-runner.js";
import { createProgram, type CliCommands } from "./program.js";

try {
  let servicePromise: Promise<CliService> | undefined;
  const loadService = (): Promise<CliService> => {
    servicePromise ??= loadConfig().then(
      (config) =>
        new CliService(
          new ApiClient(config.apiUrl, config.apiToken),
          new SpawnProcessRunner(),
        ),
    );
    return servicePromise;
  };
  const commands: CliCommands = {
    connectSession: async (sessionId) => (await loadService()).connectSession(sessionId),
    createDevbox: async (repositoryUrl, branch) =>
      (await loadService()).createDevbox(repositoryUrl, branch),
    deleteDevbox: async (devboxId) => (await loadService()).deleteDevbox(devboxId),
    ssh: async (devboxId) => (await loadService()).ssh(devboxId),
    startSession: async (devboxId, prompt) =>
      (await loadService()).startSession(devboxId, prompt),
  };
  await createProgram(commands).parseAsync(process.argv);
} catch (error: unknown) {
  const cliError = toCliError(error);
  process.stderr.write(`${cliError.code}: ${cliError.message}\n`);
  process.exitCode = 1;
}
