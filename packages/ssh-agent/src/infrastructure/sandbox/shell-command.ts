export function quoteShell(value: string): string {
	if (value.includes("\0")) throw new Error("Shell arguments cannot contain NUL");
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function shellArgv(argv: readonly string[]): string {
	return argv.map(quoteShell).join(" ");
}

export function wrapRemoteCommand(cwd: string, command: string): string {
	const script = shellArgv(["/bin/bash", "--noprofile", "--norc", "-c", command]);
	if (cwd === "~") return `cd -- "$HOME" && ${script}`;
	if (cwd.startsWith("~/")) return `cd -- "$HOME"/${quoteShell(cwd.slice(2))} && ${script}`;
	return `cd -- ${quoteShell(cwd)} && ${script}`;
}
