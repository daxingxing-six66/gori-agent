# Security

Gori is intended to run on a single user's local computer. The bundled launcher binds the frontend and backend to loopback. The backend does not provide a user login system; CORS is not authentication. Do not expose these ports to an untrusted network.

Configured AI providers receive prompts, context, and tool results used in a conversation. Gori can execute commands and access files using the permissions of the local process and configured SSH account. Guard rules and approval dialogs do not replace operating-system permissions or an isolated environment.

SSH credentials are encrypted using the saved credential key. Back up that key with the database and restrict access to both. On Windows, use a private user profile with appropriate filesystem permissions; POSIX mode bits are not a Windows access-control policy.

The first connection establishes host trust automatically. Later connections verify the saved host key. First-use trust does not independently prove that the first server reached is the intended host.

## Reporting

The maintainer must enable GitHub private vulnerability reporting before the first public release. When enabled, use the repository Security tab to report privately. If it is not available, open a minimal issue requesting a private contact channel without disclosing exploit details, credentials, or affected host information.

No security audit or support response time is promised. The initial platform verification status is documented in docs/release-readiness.md.
