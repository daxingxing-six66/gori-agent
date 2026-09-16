import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Terminal native Node runtime", () => {
	it("loads the CommonJS xterm headless runtime through Node ESM", () => {
		const packageRoot = fileURLToPath(new URL("..", import.meta.url));
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"--eval",
				`const { TerminalCanonicalState } = await import("./src/application/terminal/terminal-canonical-state.ts");
const terminal = new TerminalCanonicalState({ rows: 24, cols: 80 });
await terminal.write("node-runtime-ok");
if (!terminal.allText().includes("node-runtime-ok")) process.exitCode = 2;
terminal.dispose();`,
			],
			{ cwd: packageRoot, encoding: "utf8" },
		);

		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});
});
