"""Real PTY/kernel regression for commands produced by the actual provider."""
import errno
import fcntl
import json
import os
import pty
import re
import select
import shlex
import signal
import struct
import sys
import termios
import time

spec = json.load(open(sys.argv[1]))
checks = 0


class Terminal:
    def __init__(self, prepared):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            env = dict(os.environ, TERM="xterm-256color", HOME=spec["directory"], LC_ALL="C.UTF-8")
            os.execve("/bin/bash", ["bash", "--noprofile", "--norc", "-c", prepared["command"]], env)
        self.pending = b""
        self.output = b""
        self.reaped = False
        self.read(re.escape(prepared["confirmation"].encode()) + rb"\r?\n")
        self.run("PS1='GORI_PROMPT> '", "INITIALIZED")
        assert b"no job control" not in self.output, self.output

    def read(self, pattern, timeout=5):
        deadline = time.monotonic() + timeout
        while True:
            match = re.search(pattern, self.pending)
            if match:
                self.pending = self.pending[match.end():]
                return match
            assert time.monotonic() < deadline, (pattern, self.output[-6000:])
            if select.select([self.fd], [], [], 0.1)[0]:
                try:
                    chunk = os.read(self.fd, 65536)
                except OSError as error:
                    raise AssertionError((pattern, self.output[-6000:])) from error
                assert chunk, (pattern, self.output[-6000:])
                self.pending += chunk
                self.output += chunk

    def send(self, text):
        os.write(self.fd, text.encode() + b"\r")

    def run(self, text, marker):
        self.send(text + "; printf '\\n" + marker + "\\n'")
        self.read(rb"\r?\n" + marker.encode() + rb"\r?\n")
        self.prompt()

    def prompt(self):
        # Readline can redraw an existing prompt with cursor escapes after
        # SIGINT instead of printing PS1 again. Bracketed-paste enable marks
        # the new input cycle; drain its short redraw before sending input.
        self.read(rb"(?:GORI_PROMPT> |\x1b\[\?2004h)")
        deadline = time.monotonic() + 1
        while select.select([self.fd], [], [], 0.03)[0]:
            assert time.monotonic() < deadline, "prompt did not settle"
            chunk = os.read(self.fd, 65536)
            assert chunk
            self.output += chunk
        self.pending = b""

    def foreground(self, shell):
        deadline = time.monotonic() + 5
        while True:
            foreground = os.tcgetpgrp(self.fd)
            try:
                name = open(f"/proc/{foreground}/comm").read().strip()
            except FileNotFoundError:
                name = ""
            if foreground != shell and name in ("sleep", "cat"):
                return
            assert time.monotonic() < deadline, "foreground command did not start"
            time.sleep(0.01)

    def interrupt(self):
        os.write(self.fd, b"\x03")
        self.prompt()

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        if not self.reaped:
            try:
                os.kill(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            os.waitpid(self.pid, 0)
        except ChildProcessError:
            pass


terminal = Terminal(spec["normal"])
try:
    terminal.send('read -r p c s parent pg sid tty fg rest </proc/$$/stat; '
                  'printf "\\nTOPOLOGY=%s:%s:%s:%s:%s:%s\\n" "$p" "$parent" "$pg" "$sid" "$tty" "$fg"')
    topology = terminal.read(rb"\r?\nTOPOLOGY=(\d+):(\d+):(\d+):(\d+):(\d+):(\d+)\r?\n")
    shell, parent, group, session, tty, foreground = map(int, topology.groups())
    assert shell == group == foreground and tty != 0 and parent == session != shell, topology.groups()
    terminal.prompt()
    checks += 1
    for index in range(5):
        terminal.interrupt()
        terminal.send('printf "\\nIDLE_PID=%s\\n" "$$"')
        found = terminal.read(rb"\r?\nIDLE_PID=(\d+)\r?\n")
        assert int(found[1]) == shell
        terminal.prompt()
        checks += 1

    os.write(terminal.fd, b"printf MUST_NOT_EXECUTE")
    terminal.read(rb"MUST_NOT_EXECUTE")
    terminal.interrupt()
    terminal.run(":", "PARTIAL_CANCELLED")
    assert b"\r\nMUST_NOT_EXECUTE" not in terminal.output
    checks += 1

    for command in ["sleep 60", "sleep 60 | cat"]:
        terminal.send("printf '\\nFOREGROUND_STARTED\\n'; " + command)
        terminal.read(rb"\r?\nFOREGROUND_STARTED\r?\n")
        terminal.foreground(shell)
        terminal.interrupt()
        terminal.run(":", "FOREGROUND_INTERRUPTED")
        checks += 1

    terminal.send("sleep 60")
    terminal.read(rb"sleep 60\r?\n")
    terminal.foreground(shell)
    os.write(terminal.fd, b"\x1a")
    terminal.read(rb"Stopped")
    terminal.prompt()
    terminal.run("bg", "BACKGROUND_RESUMED")
    terminal.send("fg")
    terminal.read(rb"sleep 60\r?\n")
    terminal.foreground(shell)
    terminal.interrupt()
    terminal.run(":", "JOB_CONTROL_DONE")
    checks += 1

    # Invalid FD is deliberate: unfiltered ioctl gives EBADF, whereas our
    # seccomp rule gives EPERM before fd validation. No input can be injected.
    probe = """import ctypes,errno,os,tempfile
c=ctypes.CDLL(None,use_errno=True)
c.ioctl.argtypes=[ctypes.c_int,ctypes.c_ulong,ctypes.c_void_p]
for request in [0x5412,0x541c,0xffff000000005412]:
 ctypes.set_errno(0)
 assert c.ioctl(-1,request,None)==-1 and ctypes.get_errno()==errno.EPERM
ctypes.set_errno(0)
assert c.ioctl(-1,0x5413,None)==-1 and ctypes.get_errno()==errno.EBADF
assert os.tcgetpgrp(0)==os.getpgrp()
with tempfile.TemporaryFile(dir='/tmp') as f: f.write('中文'.encode())
try:
 open(OUTSIDE,'w').close()
 raise AssertionError('outside write allowed')
except OSError as e: assert e.errno==errno.EROFS
print('SECURITY_OK')
""".replace("OUTSIDE", repr(spec["outside"] + "/denied"))
    terminal.run("python3 -c " + shlex.quote(probe), "SECURITY_DONE")
    assert re.search(rb"[\r\n]SECURITY_OK\r?\n", terminal.output), terminal.output[-6000:]
    checks += 6

    alternate = """import os,signal,time
print('\\x1b[?1049hALT_READY',flush=True)
signal.signal(signal.SIGWINCH,lambda *_:print('RESIZED=%s:%s'%os.get_terminal_size(),flush=True))
try: time.sleep(60)
except KeyboardInterrupt: pass
finally: print('\\x1b[?1049lALT_DONE',flush=True)
"""
    terminal.send("python3 -c " + shlex.quote(alternate))
    terminal.read(rb"\x1b\[\?1049hALT_READY")
    fcntl.ioctl(terminal.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 33, 107, 0, 0))
    terminal.read(rb"RESIZED=107:33")
    os.write(terminal.fd, b"\x03")
    terminal.read(rb"\x1b\[\?1049lALT_DONE")
    terminal.prompt()
    terminal.run(":", "ALTERNATE_DONE")
    checks += 2

    terminal.send("vim -Nu NONE -n -i NONE")
    terminal.read(rb"\x1b\[\?1049h")
    os.write(terminal.fd, "i中文输入".encode())
    os.write(terminal.fd, b"\x1b:q!\r")
    terminal.read(rb"\x1b\[\?1049l")
    terminal.prompt()
    terminal.run(":", "VIM_DONE")
    checks += 1

    terminal.send("exit 7")
    deadline = time.monotonic() + 5
    while True:
        pid, status = os.waitpid(terminal.pid, os.WNOHANG)
        if pid:
            assert os.waitstatus_to_exitcode(status) == 7, status
            terminal.reaped = True
            break
        assert time.monotonic() < deadline, "bwrap did not exit with its shell"
        time.sleep(0.05)
    checks += 1
finally:
    terminal.close()

terminal = Terminal(spec["readOnly"])
try:
    terminal.run("python3 -c " + shlex.quote(probe), "READONLY_SECURITY_DONE")
    assert re.search(rb"[\r\n]SECURITY_OK\r?\n", terminal.output), terminal.output[-6000:]
    terminal.interrupt()
    terminal.run(":", "READONLY_CTRL_C_DONE")
    checks += 2
    os.close(terminal.fd)
    terminal.fd = None
    deadline = time.monotonic() + 5
    while True:
        pid, status = os.waitpid(terminal.pid, os.WNOHANG)
        if pid:
            terminal.reaped = True
            break
        assert time.monotonic() < deadline, "PTY hangup leaked the session monitor"
        time.sleep(0.05)
    checks += 1
finally:
    terminal.close()

print(f"Passed {checks} real-kernel PTY/security checks", flush=True)
