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

## Architecture

The local CLI calls a hosted backend that stores metadata in PostgreSQL and
provisions EC2 devboxes. Each devbox uses Amazon Linux 2023, an encrypted root
volume, and `cloud-init` to install its tools and check out the requested
commit. The CLI connects directly over SSH, and Codex runs inside `tmux` so its
session can be disconnected and reconnected.

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

## Intentional scope decisions and extension paths

The prototype intentionally focuses on one validated end-to-end path:

- Create requires a public GitHub repository and branch and uses one default
  environment. Private repositories and versioned environments could be added
  through GitHub authentication and environment create/select APIs.
- Devboxes use a fixed Amazon Linux 2023 image with `cloud-init`. Pre-baked
  images and warm pools could reduce startup time.
- One pinned Codex CLI, its default model, and immediate attachment are
  supported. An agent adapter plus `--agent`, `--model`, and `--no-connect`
  options could extend this without changing the session model.
- Codex authentication is completed separately on each devbox. Environment-
  scoped credentials could remove this repeated setup.
- Sessions persist only while their devbox and process remain running. Stop,
  restart, snapshots, automatic suspension, and durable recovery are deferred.
- SSH uses EC2 Instance Connect for short-lived keys, but an operator must
  restrict the demo security group's port 22 rule to the user's current public
  IPv4 address (`/32`). Private devboxes behind an EC2 Instance Connect
  Endpoint or managed gateway would remove this requirement.
