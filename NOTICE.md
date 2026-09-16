# Upstream source

Gori includes source from the pi project by Mario Zechner and contributors:

- https://github.com/earendil-works/pi
- `packages/agent`: Agent execution and tools.
- `packages/ai`: model catalog and provider adapters.
- `packages/telemetry`: telemetry contracts.

These directories preserve their upstream package identities for internal workspace resolution. Their presence does not imply that this project is an official pi release. They may contain local modifications and are kept private within the application workspace; no upstream npm namespace is published by this repository's release process.

The original MIT license is retained in LICENSE. Third-party npm dependencies retain their own licenses. Distribution artifacts should include the license notices of their bundled dependencies.
