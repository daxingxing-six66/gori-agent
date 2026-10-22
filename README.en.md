# Gori

[简体中文](README.md)

Gori is a lightweight SSH agent for individual developers. Use natural language to handle everyday operations on a single Linux server.

Gori runs on your computer and connects to remote servers over SSH. Prompts and relevant tool results are sent to the model provider you configure. Gori is a standalone application built on SSH.

> Release preparation is in progress. See [release readiness](docs/release-readiness.md) for verified results and remaining checks.

## Features

- Workspaces, sessions, saved SSH credentials, and host trust.
- Streaming AI conversations, tool approval, queues, and context compaction.
- SSH commands, SFTP transfers, and remote server metrics.
- AI terminal interaction with a read-only terminal view.
- English and Chinese interfaces, light/dark themes, and custom model providers.

## Run locally

Target platforms: macOS, Linux, and Windows. Install Node.js 22.19.0 or newer with npm. On Windows, local Bash tools also require Git Bash, provided by Git for Windows.

Download and extract the repository ZIP. Open a terminal in the repository directory and run:

```sh
node scripts/start.mjs --setup
```

This installs locked dependencies without dependency lifecycle scripts, builds the application, creates a persistent encryption key, and starts both servers. The initial setup needs an internet connection. Subsequent starts use:

```sh
npm start
```

When ready, open <http://127.0.0.1:3000>. Configure a model provider, create a workspace with SSH credentials, and start a session. Press Ctrl+C to stop. The default ports are 3000 (web), 3001 (API requests), and 3002 (SSE events). Separate API and event origins keep persistent streams from consuming the browser's API connection budget.

For different ports on macOS/Linux, run `SSH_AGENT_PORT=4311 SSH_AGENT_EVENTS_PORT=4312 npm run build`, then `SSH_AGENT_WEB_PORT=4310 npm start`. In PowerShell, set `$env:SSH_AGENT_PORT="4311"` and `$env:SSH_AGENT_EVENTS_PORT="4312"` before building, then `$env:SSH_AGENT_WEB_PORT="4310"` before starting. Open <http://127.0.0.1:4310>. Changing either backend port requires rebuilding because both addresses are embedded in the browser bundle. All three ports must differ; the launcher records the API and event ports used during the build.

## Data and security

Data and the credential key live in `~/.gori-agent` (`%USERPROFILE%\.gori-agent` on Windows). Stop the app before backing up the entire directory. The launcher and direct/development backend share this default and can use a different directory through `SSH_AGENT_DATA_DIR`. Losing `credential-key` makes saved credentials unrecoverable.

Attachments and logs are stored in `attachments/` and `logs/` beneath the data directory. Explicit database and working-directory overrides remain supported. Existing data is not moved automatically; see [migration](docs/migration.md). Redact private details before sharing them. The application has no login system and is intended for local single-user use. Do not expose it directly to a public network. Read [SECURITY.md](SECURITY.md).

## Development

The npm workspace contains the web frontend, SSH backend, and pi's agent, AI, and telemetry packages. See [CONTRIBUTING.md](CONTRIBUTING.md) for installation, checks, and test guidance.

```sh
npm ci --ignore-scripts
npm run dev
```

Open <http://127.0.0.1:3000>. This starts both servers with frontend HMR and backend source watching. Changes under `src/` in `packages/ssh-agent`, `packages/agent`, `packages/ai`, and `packages/telemetry` automatically restart the backend. Source aliases load these workspaces directly, so no initial build or manual rebuild is needed. Backend restarts recreate runtime connections and do not preserve in-memory task state. Press Ctrl+C to stop both servers and the watcher.

Set `SSH_AGENT_WEB_PORT`, `SSH_AGENT_PORT`, and `SSH_AGENT_EVENTS_PORT` before starting to use different ports; browser endpoints and backend CORS are configured together. Development neither reads nor updates the production `.build-config.json`. Data still defaults to `~/.gori-agent`; use `SSH_AGENT_DATA_DIR` for a separate directory. Export environment variables before starting; the root launcher does not load `.env` automatically.

Run `node --test scripts/start.test.mjs` for isolated launcher tests covering source updates, error recovery, port conflicts, and process cleanup.

## License and attribution

[MIT](LICENSE). Includes pi source by Mario Zechner and contributors. Original copyright notices are retained; see [NOTICE.md](NOTICE.md).
