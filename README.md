# Mini Starfolk (SFKM)

Mini Starfolk is a command-line application for creating a remote development
machine from a public GitHub repository and running a coding agent inside it.
Development happens on the remote machine rather than on the user's computer.

## What it supports

- Create a remote devbox from a public GitHub repository and branch.
- Connect to the devbox with SSH.
- Compile code and run the repository's normal test commands remotely.
- Start a Codex coding-agent session in the repository.
- Disconnect without stopping the agent.
- Reconnect to the same running agent session and terminal history.
- Delete the devbox when the work is finished.

## Install

SFKM currently installs from a checkout of this repository and requires Node.js
24 and npm 11. From the repository root, run:

```bash
./apps/cli/install.sh
```

The installer links `sfkm` into `~/.local/bin` and prompts for the demo API
token when run interactively. Keep the repository checkout in place while the
CLI is installed.

To uninstall the command:

```bash
./apps/cli/install.sh --uninstall
```

## Usage

Create a devbox:

```bash
sfkm devbox create \
  --repo https://github.com/toddwseattle/pretty-vitest-react-ts-template.git \
  --branch main
```

The command prints a `devbox_...` identifier when the machine is ready. Initial
creation may take a few minutes.

Connect with SSH and use the repository normally:

```bash
sfkm ssh <devbox-id>
pwd
npm test -- --run
npm run build
```

Before starting the first agent session on a new devbox, authenticate Codex from
that SSH session:

```bash
codex login --device-auth
```

Start an agent session:

```bash
sfkm session start <devbox-id> \
  "Add a dark and light mode toggle. Update the tests and run the test suite and build. Do not commit."
```

Detach from the session with `Ctrl-b`, then `d`. SFKM prints the session ID and
the command for reconnecting later:

```bash
sfkm session connect <session-id>
```

Reconnect over SSH to inspect the resulting changes:

```bash
sfkm ssh <devbox-id>
git status --short
git diff
```

Delete the devbox when finished:

```bash
sfkm devbox delete <devbox-id>
```

## Current limitations

- Only public GitHub repositories are supported.
- A repository URL and branch must be supplied explicitly.
- One preconfigured development environment and one Codex agent are available.
- Codex authentication is completed separately on each new devbox.
- Devboxes are created on demand, so startup is not instantaneous.
- Agent sessions remain reconnectable only while their original devbox and
  session process are still running.
- Stop, restart, snapshots, automatic suspension, and warm devboxes are not
  currently available.
- SSH access must be prepared for the demo user's current network before use.
