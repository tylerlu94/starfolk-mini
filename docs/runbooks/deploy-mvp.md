# MVP deployment runbook

This runbook deploys one SFKM backend process and one managed PostgreSQL database. It deliberately avoids infrastructure as code, a worker service and separate artifact hosting.

## Before deployment

Finalize the one demo AMI, subnet, security group, instance type, root-disk size, repository setup command and backend public URL before the first successful server start. The first start seeds an immutable default environment; changing those values later requires a fresh demo database or an intentional migration.

Build and record the runtime digest:

```bash
npm ci
npm run build --workspace @sfkm/devbox-runtime
shasum -a 256 apps/devbox-runtime/dist/sfkm-devbox-runtime.cjs
```

## Hosted service commands

Run from the monorepo root:

```text
Build: npm ci && npm run build --workspace @sfkm/devbox-runtime
Start: npm run start --workspace @sfkm/server
Health: /health/ready
```

The server reads the sibling runtime artifact, verifies its configured digest and serves it publicly from `/artifacts/sfkm-devbox-runtime`.

## Environment variables

```text
PORT                         provided by the host
DATABASE_URL                 managed PostgreSQL connection string
SFKM_PUBLIC_BASE_URL         final HTTPS backend origin, without a path
SFKM_API_TOKEN_HASH          SHA-256 of the one CLI demo token
SFKM_RESOURCE_TOKEN_KEY      random secret of at least 32 characters

AWS_REGION
AWS_ACCESS_KEY_ID            temporary, narrowly scoped demo identity
AWS_SECRET_ACCESS_KEY

SFKM_AMI_ID                  reviewed Amazon Linux 2023 AMI
SFKM_SUBNET_ID               public subnet
SFKM_SECURITY_GROUP_ID       inbound SSH from exactly the demo /32
SFKM_DEMO_SSH_CIDR           the same reviewed /32
SFKM_INSTANCE_TYPE           t3.small for the first slice
SFKM_ROOT_DISK_GB            24
SFKM_DEFAULT_AGENT           codex
SFKM_DEFAULT_MODEL           native-default
SFKM_SETUP_COMMAND           npm ci
SFKM_RUNTIME_ARTIFACT_SHA256 digest produced above
```

Store the raw CLI token, resource-token key and AWS credentials only in the hosting provider's secret store. Remove the AWS identity after the interview.

## Verify the deployment

```bash
curl --fail --silent --show-error https://YOUR_HOST/health/ready
curl --fail --silent --show-error https://YOUR_HOST/artifacts/sfkm-devbox-runtime | shasum -a 256
```

The second digest must exactly match `SFKM_RUNTIME_ARTIFACT_SHA256`.

Create `~/.config/sfkm/config.json` with mode `0600`:

```json
{
  "apiToken": "<raw-demo-token>"
}
```

Set `SFKM_API_URL=https://YOUR_HOST` while the CLI still uses its development URL override.

## Stop and cleanup

- Terminate every instance tagged `Project=sfkm-demo`.
- Confirm its delete-on-termination root volume is gone.
- Remove the temporary backend AWS identity.
- Delete the hosted service and database after the interview when their data is no longer needed.
