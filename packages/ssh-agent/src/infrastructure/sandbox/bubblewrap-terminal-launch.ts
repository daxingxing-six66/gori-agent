import { quoteShell, shellArgv } from "./shell-command.ts";
import { terminalSeccompFilter } from "./terminal-seccomp-filter.ts";

/** Uses the SSH PTY itself; no second PTY, remote file, or persistent relay. */
export function bubblewrapTerminalCommand(filesystemArgv: readonly string[], confirmation: string): string {
	const script = [
		"if [[ $- != *m* ]] || ! test -t 0 || ! test -t 1 || ! (: </dev/tty); then",
		"printf '%s\\n' 'gori-bubblewrap: terminal job control unavailable' >&2; exit 125; fi",
		`printf '%s\\n' ${quoteShell(confirmation)} >&2`,
		"exec /bin/bash --login -i",
	].join("\n");
	const argv = [...filesystemArgv, "--dev-bind", "/dev/tty", "/dev/tty", "--seccomp", "3", "--",
		"/bin/bash", "--noprofile", "--norc", "-i", "-c", script];
	// Bash's builtin printf writes fixed, escaped bytes to a short-lived pipe.
	// bwrap consumes and closes FD 3 before exec; nothing is persisted remotely.
	const octal = [...terminalSeccompFilter()].map((byte) => `\\0${byte.toString(8).padStart(3, "0")}`).join("");
	const launch = `exec ${shellArgv(argv)} 3< <(printf '%b' ${quoteShell(octal)})`;
	return `exec ${shellArgv(["/bin/bash", "--noprofile", "--norc", "-c", launch])}`;
}
