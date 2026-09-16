# Contributing to Gori

Small, focused contributions are welcome. For a substantial feature, open an issue describing the problem and a concrete use case before implementing it.

## Development

Use Node.js 22.19.0 or newer. Install with `npm ci --ignore-scripts`. Commit changes to package.json and package-lock.json together when changing dependencies. Pin direct external dependencies to exact versions.

Run `npm run check`, then the tests relevant to your changes. `npm run test:backend` and `npm run test:web` select the Gori suites. The inherited pi packages include provider integration tests; do not run those with real credentials unless you intend to contact those providers.

Explain the problem, resulting behavior, and validation in your pull request. Include a regression test when fixing a behavioral bug. Do not include node_modules, generated builds, logs, databases, credentials, or personal environment files.

## Reporting bugs

Include operating system, Node.js version, reproduction steps, expected behavior, and actual behavior. Redact credentials, hostnames, IP addresses, command output, and model conversation content as appropriate.

For a suspected security vulnerability, follow SECURITY.md. Do not include a working secret in an issue or pull request.
