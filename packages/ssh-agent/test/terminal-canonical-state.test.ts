import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { TerminalCanonicalState } from "../src/application/terminal/terminal-canonical-state.ts";

describe("TerminalCanonicalState", () => {
	it("creates a replayable ANSI snapshot and extracts logical wrapped lines", async () => {
		const source = new TerminalCanonicalState(
			{ rows: 4, cols: 12 },
			{ scrollbackRows: 20, snapshotScrollbackRows: 20 },
		);
		await source.write("first\r\n\u001b[31m红色-CJK-宽字符\u001b[0m\r\nlast");
		const snapshot = source.snapshot(17);

		const restored = new TerminalCanonicalState(
			{ rows: snapshot.rows, cols: snapshot.cols },
			{ scrollbackRows: 20, snapshotScrollbackRows: 20 },
		);
		await restored.write(Buffer.from(snapshot.data, "base64"));

		expect(restored.allText()).toBe(source.allText());
		expect(restored.currentScreenText()).toBe(source.currentScreenText());
		expect(restored.cursor).toEqual(source.cursor);
		expect(snapshot).toMatchObject({
			format: "xterm-ansi",
			formatVersion: 1,
			encoding: "base64",
			sequence: 17,
			rows: 4,
			cols: 12,
		});

		restored.dispose();
		source.dispose();
	});

	it("keeps the alternate screen as canonical state across snapshot restore", async () => {
		const source = new TerminalCanonicalState({ rows: 5, cols: 16 });
		await source.write("normal\r\n\u001b[?1049h\u001b[2J\u001b[HDashboard\r\nCPU 42%\u001b[2;8H");
		const snapshot = source.snapshot(3);
		const restored = new TerminalCanonicalState({ rows: snapshot.rows, cols: snapshot.cols });
		await restored.write(Buffer.from(snapshot.data, "base64"));

		expect(restored.activeBuffer).toBe("alternate");
		expect(restored.currentScreenText()).toBe(source.currentScreenText());
		expect(restored.cursor).toEqual(source.cursor);

		restored.dispose();
		source.dispose();
	});
});
