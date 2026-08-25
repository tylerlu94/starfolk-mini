# SFKM CLI

## Install from a repository checkout

The CLI does not need to be published to npm. From the monorepo root, run:

```bash
./apps/cli/install.sh
```

The installer verifies Node.js 24 and npm 11, installs locked repository
dependencies when needed, and links `sfkm` into `~/.local/bin`. If that
directory is not on `PATH`, it prints the exact shell-profile line to add. On an
interactive terminal it also offers to save the demo API token in the private
configuration file.

The installed command remains linked to the checkout, so code updates are
available immediately. Keep the checkout in place while using it. To uninstall
the command without deleting its configuration:

```bash
./apps/cli/install.sh --uninstall
```

The compiled default API origin is:

```text
https://sfkm-backend-production.up.railway.app
```

`SFKM_API_URL` remains available strictly as a local-development override.

The local CLI exposes this fixed prototype surface:

```text
sfkm devbox create --repo <public-github-url> --branch <branch>
sfkm devbox delete <devbox-id>
sfkm ssh <devbox-id>
sfkm session start <devbox-id> <prompt>
sfkm session connect <session-id>
```

It reads `{ "apiToken": "..." }` from `~/.config/sfkm/config.json`. The file must
be a regular file owned by the current user with no group or world permission
bits (mode `0600` is required).

## Runtime stdout protocol

Runtime commands write exactly one bounded JSON object to stdout. Diagnostics
belong on stderr.

All `session start` and `session inspect` responses use the runtime's strict
session-inspection shape. For example, a newly started session returns:

```json
{"exitCode":null,"pid":null,"recoverable":true,"sessionId":"session_00000000-0000-4000-8000-000000000000","status":"STARTING","tmuxExists":true,"tmuxName":"sfkm-00000000-0000-4000-8000-000000000000"}
```

The `status` is one of `MISSING`, `STARTING`, `RUNNING`, `SUCCEEDED`, `FAILED`,
or `UNRECOVERABLE`. Terminal results include their nullable `exitCode`; live
results must also have `recoverable: true` and `tmuxExists: true` before the CLI
will attach.

The start command receives one JSON object on standard input containing
`callbackToken` and `prompt`. Neither value is placed in command arguments.
