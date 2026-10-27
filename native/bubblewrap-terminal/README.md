# Bubblewrap interactive terminal kernel regression

Run only in a disposable Linux environment with Node.js 24+, Python 3, Bash,
Bubblewrap 0.12+, GNU coreutils, procps and Vim. No SSH credentials, model,
application database, or existing server files are used. User and mount
namespaces must be available; root is not required.

```sh
node native/bubblewrap-terminal/kernel-test.mjs
```

The actual `BubblewrapRemoteSandboxProvider` runs against a local synthetic
command broker. Random fixture directories in `/tmp` and `/var/tmp` are removed
in `finally`. Python allocates real controlling PTYs for ordinary and read-only
Terminal launches. Ordinary command preparation is checked separately.

Coverage: Shell/monitor process groups, repeated idle Ctrl+C, unfinished input,
foreground commands/pipelines, Ctrl+Z/bg/fg, ioctl injection rejection including
high argument bits, normal terminal ioctls, outside write denial, alternate
screen/SIGWINCH, Vim/CJK input, exit status and PTY hangup. Injection probes use
invalid FDs: an unfiltered request would return EBADF without injecting input.

The cBPF filter uses an in-memory Bash builtin `printf` pipe and FD 3, consumed
by bwrap before exec. No filter file or relay process is installed. A pre-login
interactive Bash validates job control and controlling-terminal access before
confirmation and execs the normal login Bash. Account startup files retain their
usual order and remain trusted; they can subsequently change Shell settings.

Commands retain `--new-session`; Terminal launches retain the SSH controlling
terminal. The filter denies TIOCSTI/TIOCLINUX and allows ordinary terminal
controls. Its supported little-endian ABIs are x86_64/x32/i386/aarch64/ARM EABI;
unknown ABIs fail closed with ENOSYS. Interpreter tests are not a substitute for
native kernel validation.

The fixture is separate from `npm run check`, which must run on macOS/Windows.
Containers can use a non-root user, no capabilities, no host mounts and no
network. Their outer syscall policy must allow creation of user namespaces;
privileged-container mode is unnecessary.
