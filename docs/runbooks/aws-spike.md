# AWS hard-gate spike

## Status

Validated against AWS on 2026-08-24 and then revalidated through the integrated
CLI and hosted backend. The runs proved idempotent launch, Amazon Linux 2023
bootstrap, EC2 Instance Connect SSH, an exact public-repository checkout,
dependency installation, tests, a production build, native Codex device
authorization, and retention of the same live Codex process across disconnect
and reconnect. Cleanup terminated the test instances and removed their
delete-on-termination root volumes.

The acceptance script checks reconnect headlessly using the retained `tmux`
session, stable agent PID, output log, wrapper-owned completion marker, and
terminal exit code. Interactive attachment is rehearsed separately from a
normal operator terminal.

## What this proves

This is the smallest risky-path validation for SFKM. It proves that one Amazon
Linux 2023 devbox can be launched idempotently, bootstrapped without long-lived
credentials in user data, reached with a temporary EC2 Instance Connect key,
used for a fixed public repository commit, and deleted with its encrypted root
volume. It also proves that the pinned native Codex process survives an SSH
disconnect inside `tmux` and is the same PID after reconnect.

The script performs one complete run. A trap terminates the active instance on
failure or interruption and verifies that its root volume is removed.

## Frozen spike choices

- OS: an explicitly supplied Amazon Linux 2023 AMI ID. Record the AMI owner,
  creation date, architecture, and image digest or build record beside the run
  evidence. The script rejects an image that cannot be identified as AL2023.
- SSH user: `ec2-user`.
- Root disk: one 24 GiB encrypted `gp3` volume, delete on termination.
- Agent: `@openai/codex@0.146.0`, installed globally from npm. The exact package
  and integrity metadata were verified in the npm registry on 2026-08-23;
  revalidate it before the demo rather than silently upgrading it.
- Agent invocation: `codex exec --sandbox workspace-write -`. The pinned CLI
  selects the authenticated account's default supported model.
  The prompt is mode `0600` and reaches Codex through standard input. Official
  OpenAI documentation defines `codex exec -` as the explicit stdin-prompt form:
  <https://learn.chatgpt.com/docs/non-interactive-mode#use-codex-exec-when-stdin-is-the-prompt>.
- Repository: `https://github.com/toddwseattle/pretty-vitest-react-ts-template.git`
  at commit `69303abf8568b6384afe95dec4d2e10f72847e9d`.
- Repository commands: `npm ci`, `npm run type-check`, `npm test -- --run`, and
  `npm run build`. The repository commits a `package-lock.json`, supports the
  selected Node.js 24 runtime, and provides deterministic type-check, test, and
  production-build paths without application services or native dependencies.
- Network: one public subnet and a precreated security group whose only IPv4
  port-22 CIDR is the operator's fixed `/32`.
- Identity: no EC2 instance profile. Agent authentication is completed natively
  and interactively as `ec2-user`; it is never copied into user data or backend
  configuration.

If any frozen choice changes, update this runbook and the script in the same
review. Do not use an unpinned repository branch, AMI alias or agent package
for acceptance evidence. Record the model Codex actually selects in the run
evidence rather than forcing a potentially stale model identifier.

## One-time AWS prerequisites

Prepare these manually in the dedicated demo account:

1. A public subnet with a route to an internet gateway and automatic/public IPv4
   support.
2. A security group allowing inbound TCP/22 only from the operator's current
   public IPv4 `/32`, plus unrestricted or sufficient outbound HTTPS/DNS.
3. An available AL2023 AMI compatible with the chosen instance type. Its package
   repositories must supply Git, `tmux`, `gcc-c++`, `make`, `nodejs24`, and
   `nodejs24-npm`; outbound npm and GitHub access must work.
4. A dedicated temporary AWS identity. Start from
   `infra/aws/demo-backend-policy.json`, then restrict `RunInstances` resources
   to the actual AMI, subnet, security group, and EBS resources. The identity
   needs STS identity lookup for the script in addition to the EC2 and Instance
   Connect operations in that file. Do not grant `iam:PassRole` because the
   instance has no role.
5. AWS CLI v2, `jq`, OpenSSH, `ssh-keygen`, and `uuidgen` on the operator machine.
6. A public GitHub HTTPS repository URL and a full 40-character lowercase
   commit SHA that exists in that repository.

Before setting the launch confirmation, inspect identity and resources without
creating anything:

```bash
aws sts get-caller-identity
aws ec2 describe-images --region "$AWS_REGION" --image-ids "$SFKM_SPIKE_AMI_ID"
aws ec2 describe-subnets --region "$AWS_REGION" --subnet-ids "$SFKM_SPIKE_SUBNET_ID"
aws ec2 describe-security-groups --region "$AWS_REGION" --group-ids "$SFKM_SPIKE_SECURITY_GROUP_ID"
```

Never paste the output of `env`, `aws configure export-credentials`, or AWS
credential files into evidence. Record only account ID, role/user ARN, region,
and resource IDs. Store access keys in the normal AWS credential provider chain,
not in this repository.

## Run

Start with no other real-AWS SFKM test running. From the repository root, export
the reviewed values:

```bash
export AWS_PROFILE=sfkm-demo
export AWS_REGION=us-west-2
export SFKM_SPIKE_AMI_ID=<reviewed-al2023-ami-id>
export SFKM_SPIKE_SUBNET_ID=<public-subnet-id>
export SFKM_SPIKE_SECURITY_GROUP_ID=<demo-security-group-id>
export SFKM_SPIKE_SSH_CIDR=<operator-public-ip>/32
export SFKM_SPIKE_OWNER=interview-demo
export SFKM_SPIKE_REPO_URL=https://github.com/toddwseattle/pretty-vitest-react-ts-template.git
export SFKM_SPIKE_REPO_SHA=69303abf8568b6384afe95dec4d2e10f72847e9d
export SFKM_AWS_SPIKE_CONFIRM=launch-one-billable-instance
./scripts/aws/aws-spike.sh
```

The confirmation value is intentionally verbose. Setting it authorizes one
billable instance. The script performs a second identical `RunInstances`
request with the same client token and requires AWS to return the same instance
ID rather than create another instance.

For the newly launched instance, the script will open an interactive SSH login
step. Complete `codex login --device-auth` as `ec2-user` using the URL and
one-time code on a local browser. The login command and SSH connection close
automatically after authorization. The script writes the prompt through SSH
standard input, starts Codex in detached `tmux`, disconnects, gets fresh
Instance Connect authorizations, and checks the same live agent PID. It then
verifies the retained tmux session, output log, wrapper-owned completion marker,
and terminal exit code without depending on interactive terminal rendering.

The SSH private key and `known_hosts` file live only in a mode-`0700` temporary
directory. OpenSSH uses `StrictHostKeyChecking=accept-new`; the script never uses
`StrictHostKeyChecking=no`. EC2 Instance Connect authorization is refreshed for
each distinct connection.

## Pass evidence

Capture non-secret evidence for the run:

- date, operator, AWS account ID/role ARN, region, exact AMI ID and provenance;
- instance ID, availability zone, instance type, and public address;
- identical instance ID from the client-token replay;
- instance metadata options showing `HttpTokens=required`;
- instance and volume tags: `Project=sfkm-demo`, `SFKMDevboxId`,
  `EnvironmentVersion=aws-spike`, and `Owner`;
- root volume type, encryption status, size, and delete-on-termination mapping;
- `uname -a`, `/etc/os-release`, `node --version`, `npm --version`,
  `tmux -V`, `git --version`, and `codex --version` from the instance;
- `git rev-parse HEAD` equal to `SFKM_SPIKE_REPO_SHA`;
- successful `npm ci`, `npm run type-check`, `npm test -- --run`, and
  `npm run build`;
- first and reconnected agent PID values, which must be identical, plus the
  headless reconnect snapshot, retained pane, completion marker, and exit code;
- terminal agent exit code for success; separately rehearse a known failing
  prompt/command, cancellation, and reconnect after an already-finished session
  before freezing the runtime adapter;
- terminated EC2 state and a failed/empty root-volume describe after the run.

The automation covers success and cleanup mechanics. Before the demo, the
operator still manually attaches from a normal terminal to confirm interactive
rendering and exercises failure, cancellation, and already-finished behavior;
those presentation semantics do not control automated infrastructure cleanup.

## Failure and independent cleanup

On `EXIT`, `INT`, or `TERM`, the spike script terminates its active instance,
waits for `terminated`, and polls the captured root volume until it disappears.
If the terminal is lost or the application database has no instance record, use
the tag-only cleanup path:

```bash
export AWS_REGION=us-west-2
export SFKM_SPIKE_OWNER=interview-demo
export SFKM_AWS_CLEANUP_CONFIRM=terminate-all-listed-sfkm-demo-instances
./scripts/aws/cleanup-tagged-devboxes.sh
```

That script first lists the exact tagged instances, terminates them, waits, and
then displays any surviving tagged volume. It deliberately does not delete a
surviving volume automatically: investigate why delete-on-termination failed,
record evidence, then delete the exact reviewed volume ID with a separate AWS
command. Remove the demo AMI and its backing snapshot separately after the
interview only when their exact IDs have been reviewed.

## Stop conditions

Stop and fix or redesign before backend integration if any of these occur:

- a client-token replay creates or identifies a second instance;
- user data or logs contain an AWS key, agent credential, prompt, or callback
  token;
- AL2023 package installation is not reproducible;
- SSH requires disabling host-key checks or widening the `/32`;
- the native agent cannot start from stdin, persist inside `tmux`, expose a
  stable PID, or reconnect with terminal history;
- a second start creates a duplicate agent process;
- termination does not remove the encrypted root volume; or
- the complete run needs an undocumented manual repair.

Only after this run passes should the integration owner enable one controlled
backend/CLI real-AWS smoke test. Never run that smoke test concurrently with
this spike.
