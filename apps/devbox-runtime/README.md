# SFKM devbox runtime

`sfkm-devbox-runtime` is the small, single-host helper installed on an SFKM
Amazon Linux 2023 devbox. It clones the requested public repository commit,
starts the pinned Codex process inside a deterministic `tmux` session, and
reports lifecycle callbacks. It never calls AWS.

## Reproducible artifact

Build from a clean checkout with the repository-pinned Node.js and npm versions:

```bash
npm ci
npm run build --workspace @sfkm/devbox-runtime
sha256sum apps/devbox-runtime/dist/sfkm-devbox-runtime.cjs
```

The build uses the workspace's locked esbuild installation to bundle the runtime,
Zod, Commander, and the frozen contracts into one executable CommonJS file. The
result has a Node shebang and mode `0755`; no `node_modules` directory is needed
on the devbox. Publish that exact `.cjs` file over HTTPS, configure its SHA-256
as the runtime artifact checksum, and install it without the extension as shown
below.

Amazon Linux must provide Node.js 24, Git, `tmux`, a C/C++ build toolchain for
native repository dependencies, and the pinned native agent:

```bash
sudo npm install --global @openai/codex@0.146.0
sudo install -o ec2-user -g ec2-user -m 0755 sfkm-devbox-runtime.cjs /usr/local/bin/sfkm-devbox-runtime
sudo install -d -o ec2-user -g ec2-user -m 0700 /workspace /var/lib/sfkm /var/lib/sfkm/sessions
```

Run bootstrap and all session commands as `ec2-user`, the same user that owns
the native Codex login state. The runtime uses the authenticated Codex CLI's
default supported model:

```text
codex exec --sandbox workspace-write -
```

The prompt is opened from its mode-`0600` file and piped to Codex standard input;
it is never included in an argument.

## Command protocol

Bootstrap reads one strict JSON object from standard input:

```json
{
  "bootstrapToken": "<resource token>",
  "callbackUrl": "https://api.example.com/v1/internal/devboxes/devbox_.../status",
  "devboxId": "devbox_00000000-0000-4000-8000-000000000000",
  "repository": {
    "branch": "main",
    "commitSha": "0123456789abcdef0123456789abcdef01234567",
    "url": "https://github.com/example/public-repo.git"
  },
  "setupCommand": "npm ci"
}
```

```bash
printf '%s' "$BOOTSTRAP_JSON" | sfkm-devbox-runtime bootstrap
printf '%s' "$SESSION_JSON" | sfkm-devbox-runtime session start \
  session_00000000-0000-4000-8000-000000000000 \
  --callback-url https://api.example.com/v1/internal/sessions/session_.../status
sfkm-devbox-runtime session inspect session_00000000-0000-4000-8000-000000000000
sfkm-devbox-runtime session attach session_00000000-0000-4000-8000-000000000000
```

Session-start stdin is exactly `{"callbackToken":"...","prompt":"..."}`.
Status commands emit one compact JSON object and never include the prompt or
token. HTTP callback URLs are accepted only for loopback test servers; production
callbacks must use HTTPS.
