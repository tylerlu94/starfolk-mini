import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { createApp, createLogger } from "./app.js";
import { createEc2AwsDevboxProvider } from "./aws/provider.js";
import { loadConfig } from "./config.js";
import { runMigrations } from "./db/migrations.js";
import { PostgresStore } from "./db/postgres.js";
import { BackendService } from "./service.js";

const config = loadConfig();
const logger = createLogger();
const runtimeArtifactPath = fileURLToPath(
  new URL("../../devbox-runtime/dist/sfkm-devbox-runtime.cjs", import.meta.url),
);
const runtimeArtifact = await readFile(runtimeArtifactPath);
const runtimeArtifactSha256 = createHash("sha256").update(runtimeArtifact).digest("hex");
if (runtimeArtifactSha256 !== config.environment.runtimeArtifactSha256) {
  throw new Error("The runtime artifact does not match SFKM_RUNTIME_ARTIFACT_SHA256.");
}
const store = new PostgresStore(config.databaseUrl);

await runMigrations(store.pool);
await store.seedDefaultEnvironment({
  amiId: config.environment.amiId,
  configurationHash: config.environment.configurationHash,
  defaultAgent: config.environment.defaultAgent,
  defaultModel: config.environment.defaultModel,
  instanceType: config.environment.instanceType,
  rootDiskGb: config.environment.rootDiskGb,
  runtimeArtifactSha256: config.environment.runtimeArtifactSha256,
  runtimeArtifactVersion: config.environment.runtimeArtifactVersion,
  setupCommand: config.environment.setupCommand,
  version: config.environment.version,
});

const aws = createEc2AwsDevboxProvider(config.awsRegion);
const service = new BackendService(store, aws, config);
const reconciliation = await service.reconcileStartup();
logger.info(reconciliation, "SFKM startup reconciliation completed");
const server = createServer(createApp({ config, logger, runtimeArtifact, service, store }));

server.listen(config.port, () => {
  logger.info({ port: config.port }, "SFKM server listening");
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "SFKM server shutting down");
  server.close();
  await store.close();
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
