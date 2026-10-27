import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bubblewrapTerminalCommand } from "../src/infrastructure/sandbox/bubblewrap-terminal-launch.ts";
import { terminalSeccompFilter } from "../src/infrastructure/sandbox/terminal-seccomp-filter.ts";

describe.skipIf(process.platform === "win32")("Bubblewrap interactive launch", () => {
	it("delivers exact binary filter bytes on FD 3 and keeps stdin separate", () => {
		const directory = mkdtempSync(join(tmpdir(), "gori-terminal-launch-"));
		try {
			const fake = join(directory, "fake bwrap's command");
			const filter = join(directory, "filter");
			const input = join(directory, "input");
			writeFileSync(fake, '#!/bin/sh\ncat <&3 > "$FILTER_FILE"\ncat > "$INPUT_FILE"\n', { mode: 0o700 });
			const command = bubblewrapTerminalCommand([fake, "--ro-bind", "/", "/"], "ready 'quoted' token=123");
			execFileSync("/bin/bash", ["--noprofile", "--norc", "-c", command], {
				input: "unmodified stdin\n", env: { ...process.env, FILTER_FILE: filter, INPUT_FILE: input },
			});
			expect(readFileSync(filter)).toEqual(terminalSeccompFilter());
			expect(readFileSync(input, "utf8")).toBe("unmodified stdin\n");
			expect(command).not.toContain("--new-session");
			expect(command).toContain("--seccomp");
			expect(command).toContain("/dev/tty");
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});
	it("propagates a failed bwrap launch without reporting readiness", () => {
		const command = bubblewrapTerminalCommand(["/bin/false"], "must-not-confirm");
		expect(() => execFileSync("/bin/bash", ["--noprofile", "--norc", "-c", command], { stdio: "pipe" })).toThrow();
	});
	it("rejects a shell without a controlling PTY before emitting confirmation", () => {
		const directory = mkdtempSync(join(tmpdir(), "gori-terminal-no-pty-"));
		try {
			const fake = join(directory, "bwrap");
			writeFileSync(fake, '#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o700 });
			const command = bubblewrapTerminalCommand([fake], "must-not-confirm");
			const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", command], { encoding: "utf8" });
			expect(result.status).toBe(125);
			expect(result.stderr).toContain("terminal job control unavailable");
			expect(result.stderr).not.toContain("must-not-confirm");
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});
});
