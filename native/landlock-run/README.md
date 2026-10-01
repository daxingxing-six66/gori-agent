# Remote Linux Landlock launcher

`main.c` is Gori's MIT-licensed native launcher. Its UAPI constants target Linux x64 and arm64. It requires Landlock ABI 5 or newer: ABI 3 handles truncate and ABI 5 handles device ioctl. The v3 `--probe` protocol reports `gori-landlock: unavailable` when the kernel returns `ENOSYS` or `EOPNOTSUPP`. Failed rules and failed restriction return 125 before starting the command. A functional probe installs restrictions in a disposable child and verifies an ungranted directory open is denied.

Build both checked-in static musl resources with Zig **0.15.2**:

```sh
GORI_ZIG=/path/to/zig node native/landlock-run/build.mjs
node native/landlock-run/check-resources.mjs
```

Normal application builds validate the shipped resources; they do not download or invoke a C compiler. The manifest records source/binary SHA-256 values and the compiler version. The package's `resources` directory must travel with `dist`. Musl's license is included in `packages/ssh-agent/resources/sandbox/MUSL-COPYRIGHT`; the root MIT license covers Gori's original source and is also shipped as `resources/sandbox/LICENSE`.

Run real kernel tests in a **disposable Linux environment** with Bash, Python 3 and Node available:

```sh
python3 native/landlock-run/security-test.py packages/ssh-agent/resources/sandbox/linux-arm64/gori-landlock-run
```

Use `linux-x64` on x64. Tests create synthetic files under a temporary directory and cover outside writes, truncation, deletion, rename, symlink escape, descendant/interpreter inheritance, writable inherited descriptors, partial effects and simulated absent syscalls. Exit 125 is reserved for launcher preparation/exec failures, but a user command can also return 125; consumers use the initial confinement confirmation rather than inferring successful enforcement from an exit code.

`ssh-smoke-test.mjs` additionally exercises the actual backend, Host Trust, SFTP deployment and SSH exec against an explicitly provisioned disposable loopback fixture. It uses an in-memory database, synthetic `goritest` credentials and no model requests. Provision `/opt/app` owned by `goritest`, Bash/coreutils/Node and an SSH server whose fixture password is `gori-synthetic-test-password`, then run from the built repository:

```sh
GORI_SANDBOX_TEST_PORT=<fixture-loopback-port> node native/landlock-run/ssh-smoke-test.mjs
```

Use a fresh fixture because the script writes synthetic files in `/opt/app`. Dispose of the fixture after testing. No actual server credentials are accepted by the script.

The policy grants read/execute on `/` and content writes only on the configured root, `/tmp` and `/dev/null`. The provider requires `/tmp` to resolve to `/tmp` itself. The launcher opens every rule-path component without following symlinks, passes that same final FD to Landlock, and rejects a writable rule resolving to the filesystem root. This prevents another process from replacing a previously canonicalized writable root with a symlink to `/` before launch. The launcher supports `--confirm-token <32 lowercase hex> ... -- --terminal`: it checks the account's login shell before restriction, applies Landlock, emits a token-bound confirmation, and execs that shell with a login argv0. Terminal Mode falls back to an unconfined SSH shell only for explicit unsupported capability verdicts; command mode keeps its own fail-closed behavior.

The remote SSH account, its shell startup files and launcher cache must be trusted. SSH exec may run account shell startup code before the launcher installs Landlock, and another same-account Full Access process can replace user-owned launcher files. The nonce confirmation records the expected launch sequence; it is not attestation against a malicious remote account. Landlock is not a complete host isolation boundary: file metadata changes (such as chmod/chown), networking and IPC are outside this filesystem policy. SFTP is not confined. See the [Linux Landlock limitations](https://docs.kernel.org/userspace-api/landlock.html#current-limitations).
