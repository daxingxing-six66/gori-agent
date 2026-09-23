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

When ready, open <http://127.0.0.1:3000>. Configure a model provider, create a workspace with SSH credentials, and start a session. Press Ctrl+C to stop. Ports 3000 and 3001 are the defaults.

For different ports on macOS/Linux, run `SSH_AGENT_PORT=4311 npm run build`, then `SSH_AGENT_WEB_PORT=4310 npm start`. In PowerShell, set `$env:SSH_AGENT_PORT="4311"` before building and `$env:SSH_AGENT_WEB_PORT="4310"` before starting. Open <http://127.0.0.1:4310>. Changing the backend port requires rebuilding because its address is embedded in the browser bundle. The launcher records the backend port used during the build.

## Data and security

Data and the credential key live in `~/.gori-agent` (`%USERPROFILE%\.gori-agent` on Windows). Stop the app before backing up the entire directory. The launcher and direct/development backend share this default and can use a different directory through `SSH_AGENT_DATA_DIR`. Losing `credential-key` makes saved credentials unrecoverable.

Attachments and logs are stored in `attachments/` and `logs/` beneath the data directory. Explicit database and working-directory overrides remain supported. Existing data is not moved automatically; see [migration](docs/migration.md). Redact private details before sharing them. The application has no login system and is intended for local single-user use. Do not expose it directly to a public network. Read [SECURITY.md](SECURITY.md).

## Development

The npm workspace contains the web frontend, SSH backend, and pi's agent, AI, and telemetry packages. See [CONTRIBUTING.md](CONTRIBUTING.md) for installation, checks, and test guidance.

## License and attribution

[MIT](LICENSE). Includes pi source by Mario Zechner and contributors. Original copyright notices are retained; see [NOTICE.md](NOTICE.md).
