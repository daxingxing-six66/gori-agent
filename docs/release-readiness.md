# Release readiness

Status: preparation in progress; no public release has been made.

| Item | Status |
| --- | --- |
| Five-package source export, without original Git history | Prepared |
| Independent package metadata and lockfile | Prepared; all five workspaces private |
| npm known-vulnerability audit | 0 findings on 2026-09-11 after targeted updates |
| Model catalog snapshot validation | Passed |
| Fresh install and type checks | npm ci --ignore-scripts and npm run check passed in standalone directory with its own installed dependencies |
| Backend and frontend build | Passed on macOS / Node 24.19.0, including an isolated copy outside the original repository |
| First initialization and key reuse | Passed: startup creates a 0600 key; restart preserves key and saved application settings; missing/invalid key refuses startup without replacement |
| One-command setup | Install, build and start stages verified individually; --setup combined invocation not separately repeated |
| macOS runtime | Passed: production HTTP 200, backend health, workspace API, CORS, browser navigation and dialogs, restart and port cleanup |
| Linux runtime | Pending |
| Windows runtime and local shell tool compatibility | Pending |
| SSH/SFTP and real model smoke test | Pending; no credentials used in preparation |
| Public README and contribution guidance | Chinese/English README, contribution guide, security policy, and attribution prepared |
| GitHub Pages introduction | Static page prepared; HTTP 200, browser layout and install anchor checked |
| Current files and original history secret review | No matches in a limited private-key/token pattern scan of exported source and docs; original history is excluded, not audited |
| Maintainer GitHub account and remote URL | Pending |
| Private security reporting | Enable before public release |
| Attachment backup paths and upgrade validation | Launcher sets backend working directory to data directory; upgrade verification pending |

The standalone repository is now gori-agent, alongside the original pi backup. Development continues here. See migration.md for source comparison and naming boundaries.

The first type-check pass found an inherited ai live probe depending on coding-agent; the standalone export excludes that probe. Four frontend test files now use the complete locale catalogs and valid locale/message types. Their 19 tests passed again with the final Vitest 4.1.11 installation.

The installation reports deprecation notices for inherited eslint 9.39.4, prebuild-install 7.1.3, and node-domexception 1.0.0. These are separate from npm's known-vulnerability audit, which has zero findings. Build/runtime checks ran in `/tmp/ssh-agent-validation.gzZ3ma/app` with its own dependencies and temporary data, outside the original repository.

Security updates include Next.js 16.3.4, React/React DOM/RSC 19.2.8, Vinext 1.0.0-beta.9, Vite 8.3.0, the RSC plugin 0.5.34, and Vitest/coverage 4.1.11. See the [Next.js Windows advisory](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36) and [React Server Functions advisory](https://github.com/react/react/security/advisories/GHSA-wx67-qw84-cm4g). Local production startup after these updates passed; cross-platform and real-provider compatibility remain unverified.

## Runtime acceptance — 2026-09-11

- Fixed an inherited Node-only build type error by using `NonNullable<RequestInit["body"]>` instead of the unavailable DOM `BodyInit` type. No request behavior changed.
- Default ports were already occupied by other local services. The launcher now accepts a web port and records the API port used at build time; conflicting runtime API configuration fails explicitly. Tested on 4310/4311 without stopping existing services.
- Replaced the homepage's simulated conversation with a Chinese/English welcome page after maintainer approval. Original prototype source remains. Browser checks verified settings, the empty provider list, and the workspace creation dialog; no credentials were entered.
- Automated local smoke assertions passed for HTTP, CORS, empty workspace data, key permissions, key reuse, settings persistence after restart, shutdown port release, and missing/invalid key protection.
- `npm run check` passes. Builds still report a client chunk above 500 kB and Vinext's inability to statically classify the home route. Neither prevented production startup; bundle splitting remains future optimization.
- This is startup and lifecycle acceptance, not a complete SSH/SFTP, AI conversation, credential decryption, attachment migration, or three-platform end-to-end test.

## Gori migration — 2026-09-11

The candidate was moved into the standalone gori-agent directory. The maintainer requested removal of the welcome page; the root route now contains only the existing workspace sidebar, with no simulated conversation. Branding and the Chinese project description are updated. AI documentation and its linked contracts were imported; private test-environment details were replaced with a safe local guide. AI checks are included in npm run check. The default data directory is now ~/.gori-agent; old data is not automatically moved.

Validation in the final directory: fresh `npm ci --ignore-scripts` passed (0 audit findings); `npm run check` passed with 23 AI feature documents; 10 focused locale/theme tests passed; all five workspaces built successfully. Production startup on 4310/4311 with temporary data passed, and the browser showed Gori with the existing sidebar and no welcome section. Existing build-size/classification notices remain. No Git commit or remote was created.
