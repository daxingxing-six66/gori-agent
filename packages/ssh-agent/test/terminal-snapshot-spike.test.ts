import { SerializeAddon } from "@xterm/addon-serialize";
import { type ITerminalAddon, Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";

interface TerminalFingerprint {
	readonly activeBuffer: "normal" | "alternate";
	readonly cols: number;
	readonly cursorX: number;
	readonly cursorY: number;
	readonly lines: readonly {
		readonly isWrapped: boolean;
		readonly text: string;
		readonly cells: readonly {
			readonly background: number;
			readonly characters: string;
			readonly foreground: number;
			readonly width: number;
		}[];
	}[];
	readonly rows: number;
}

class HeadlessSerializeAddon implements ITerminalAddon {
	readonly #addon = new SerializeAddon();

	activate(terminal: Terminal): void {
		// addon-serialize is runtime-compatible with headless xterm, but its public
		// declaration names only the browser Terminal class.
		this.#addon.activate(terminal as unknown as Parameters<SerializeAddon["activate"]>[0]);
	}

	dispose(): void {
		this.#addon.dispose();
	}

	serialize(scrollback: number): string {
		return this.#addon.serialize({ scrollback });
	}
}

const writeTerminal = (terminal: Terminal, data: string): Promise<void> =>
	new Promise((resolve) => {
		terminal.write(data, resolve);
	});

const fingerprintTerminal = (terminal: Terminal): TerminalFingerprint => {
	const buffer = terminal.buffer.active;
	const lines = [];
	for (let row = 0; row < buffer.length; row += 1) {
		const line = buffer.getLine(row);
		if (!line) {
			continue;
		}
		const cells = [];
		for (let column = 0; column < line.length; column += 1) {
			const cell = line.getCell(column);
			if (!cell) {
				continue;
			}
			cells.push({
				background: cell.getBgColor(),
				characters: cell.getChars(),
				foreground: cell.getFgColor(),
				width: cell.getWidth(),
			});
		}
		lines.push({
			cells,
			isWrapped: line.isWrapped,
			text: line.translateToString(true),
		});
	}
	return {
		activeBuffer: buffer.type,
		cols: terminal.cols,
		cursorX: buffer.cursorX,
		cursorY: buffer.cursorY,
		lines,
		rows: terminal.rows,
	};
};

const restoreSnapshot = async (snapshot: string, cols: number, rows: number): Promise<Terminal> => {
	const restored = new Terminal({ allowProposedApi: true, cols, rows, scrollback: 20 });
	await writeTerminal(restored, snapshot);
	return restored;
};

describe("terminal ANSI snapshot dependency spike", () => {
	it("restores wrapped CJK text, colors, cursor and normal-buffer scrollback", async () => {
		const source = new Terminal({ allowProposedApi: true, cols: 12, rows: 4, scrollback: 20 });
		const serializer = new HeadlessSerializeAddon();
		source.loadAddon(serializer);

		await writeTerminal(source, "first\r\n\u001b[31m红色-CJK-宽字符\u001b[0m\r\nlast");
		const snapshot = serializer.serialize(20);
		const restored = await restoreSnapshot(snapshot, source.cols, source.rows);

		expect(fingerprintTerminal(restored)).toEqual(fingerprintTerminal(source));
		expect(snapshot).toContain("\u001b[");

		restored.dispose();
		source.dispose();
	});

	it("restores alternate-screen state and remains equivalent after resize", async () => {
		const source = new Terminal({ allowProposedApi: true, cols: 16, rows: 5, scrollback: 20 });
		const serializer = new HeadlessSerializeAddon();
		source.loadAddon(serializer);

		await writeTerminal(
			source,
			"normal screen\r\n\u001b[?1049h\u001b[2J\u001b[H\u001b[32mDashboard\u001b[0m\r\nCPU 42%\u001b[2;8H",
		);
		const snapshot = serializer.serialize(20);
		const restored = await restoreSnapshot(snapshot, source.cols, source.rows);

		expect(fingerprintTerminal(restored)).toEqual(fingerprintTerminal(source));
		expect(restored.buffer.active.type).toBe("alternate");

		source.resize(20, 6);
		restored.resize(20, 6);
		await writeTerminal(source, "\u001b[3;1Hresize-ok");
		await writeTerminal(restored, "\u001b[3;1Hresize-ok");
		expect(fingerprintTerminal(restored)).toEqual(fingerprintTerminal(source));

		restored.dispose();
		source.dispose();
	});
});
