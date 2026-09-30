"""Synthetic Linux kernel tests; never uses SSH credentials or existing server files."""
import ctypes
import errno
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile

launcher = str(Path(sys.argv[1]).resolve())
if sys.platform != "linux":
    raise SystemExit("Run these tests in a disposable Linux environment.")
probe = subprocess.run([launcher, "--probe"], capture_output=True, text=True)
assert probe.returncode == 0 and "enforcement=full" in probe.stdout, probe
print(probe.stdout.strip(), flush=True)
checks = 0
with tempfile.TemporaryDirectory(prefix="gori-landlock-test-") as directory:
    base = Path(directory)
    root = base / "app"
    outside = base / "outside"
    root.mkdir()
    outside.mkdir()
    victim = outside / "existing"
    victim.write_text("preserve")  # Baseline: this user can write outside the sandbox.
    (root / "escape").symlink_to(outside, target_is_directory=True)
    rules = [launcher, "--ro", "/", "--rw", "/dev/null", "--rw", str(root), "--"]

    def run(script, allowed=False, extra_rules=None):
        global checks
        argv = rules if extra_rules is None else extra_rules
        result = subprocess.run(argv + ["/bin/bash", "--noprofile", "--norc", "-c", script], cwd=root, capture_output=True, text=True)
        assert (result.returncode == 0) == allowed, (script, result)
        assert "gori-landlock: confined abi=" in result.stderr, result
        checks += 1
        return result

    q = shlex.quote
    run("cat /etc/hosts >/dev/null; echo ok > allowed; mkdir nested; /bin/sh -c 'echo child > nested/child'", allowed=True)
    assert (root / "nested/child").read_text().strip() == "child"
    run(f"echo denied > {q(str(outside / 'created'))}")
    run("echo denied > escape/created")
    run(f"truncate -s 0 {q(str(victim))}")
    run(f"cp allowed {q(str(victim))}")
    run(f"mv allowed {q(str(outside / 'moved'))}")
    run(f"rm {q(str(victim))}")
    run(f"mkdir {q(str(outside / 'directory'))}")
    run("python3 -c " + q("from pathlib import Path; Path(" + repr(str(victim)) + ").write_text('denied')"))
    run("node -e " + q("require('fs').writeFileSync(" + json.dumps(str(victim)) + ",'denied')"))
    run("/bin/sh -c " + q("/bin/sh -c " + q(f"echo denied > {q(str(victim))}")))
    # Earlier successful effects survive a later denial: callers must not retry blindly.
    run(f"echo partial > partial; echo denied > {q(str(victim))}")
    assert (root / "partial").read_text().strip() == "partial"
    assert victim.read_text() == "preserve"
    assert not (outside / "created").exists()
    temp_rules = [launcher, "--ro", "/", "--rw", "/dev/null", "--rw", "/tmp", "--rw", str(root), "--"]
    run(f"echo temporary > {q(str(base / 'temp-file'))}", allowed=True, extra_rules=temp_rules)
    # Inherited writable descriptors beyond SSH stdio are closed before exec.
    descriptor = os.open(victim, os.O_WRONLY)
    try:
        result = subprocess.run(rules + ["python3", "-c", f"import os; os.write({descriptor}, b'bad')"], pass_fds=(descriptor,), capture_output=True)
        assert result.returncode != 0 and victim.read_text() == "preserve", result
        checks += 1
    finally:
        os.close(descriptor)
    marker = root / "must-not-run"
    for arguments in [[], ["--rw", "relative", "--", "/bin/true"], ["--rw", str(base / "missing"), "--", "/bin/sh", "-c", f"touch {q(str(marker))}"], ["--ro", "/", "--", "/missing-program"]]:
        result = subprocess.run([launcher] + arguments, capture_output=True)
        assert result.returncode == 125 and not marker.exists(), result
        checks += 1

    # Simulate a host without the Landlock syscall using an inherited seccomp filter.
    class Filter(ctypes.Structure):
        _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte), ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint)]

    class Program(ctypes.Structure):
        _fields_ = [("length", ctypes.c_ushort), ("filters", ctypes.POINTER(Filter))]

    def without_landlock():
        filters = (Filter * 4)(Filter(0x20, 0, 0, 0), Filter(0x15, 0, 1, 444), Filter(0x06, 0, 0, 0x00050000 | errno.ENOSYS), Filter(0x06, 0, 0, 0x7fff0000))
        program = Program(4, filters)
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(38, 1, 0, 0, 0) or libc.prctl(22, 2, ctypes.byref(program), 0, 0):
            os._exit(99)

    for arguments in [["--probe"], ["--ro", "/", "--rw", str(root), "--", "/bin/sh", "-c", f"touch {q(str(marker))}"]]:
        result = subprocess.run([launcher] + arguments, preexec_fn=without_landlock, capture_output=True)
        assert result.returncode == 125 and not marker.exists(), result
        checks += 1
print(f"Passed {checks} real-kernel checks", flush=True)
