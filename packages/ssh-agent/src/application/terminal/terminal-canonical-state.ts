import { Buffer } from "node:buffer";
import { SerializeAddon } from "@xterm/addon-serialize";
import HeadlessRuntime, { type Terminal as HeadlessTerminal, type ITerminalAddon } from "@xterm/headless";
import type { TerminalGeometry } from "../../domain/terminal.ts";
import { TERMINAL_DEFAULTS } from "./terminal-defaults.ts";

export interface TerminalSnapshot {
	readonly format: "xterm-ansi";
	readonly formatVersion: 1;
	readonly encoding: "base64";
	readonly data: string;
	readonly sequence: number;
	readonly rows: number;
	readonly cols: number;
}

const { Terminal } = HeadlessRuntime;

class HeadlessSerializeAddon implements ITerminalAddon {
	readonly #addon = new SerializeAddon();

	activate(terminal: HeadlessTerminal): void {
		const runtimeAddon = this.#addon as unknown as { activate(value: HeadlessTerminal): void };
		runtimeAddon.activate(terminal);
	}

	dispose(): void {
		this.#addon.dispose();
	}

	serialize(scrollback: number): string {
		return this.#addon.serialize({ scrollback });
	}
}

export class TerminalCanonicalState {
	readonly #terminal: HeadlessTerminal;
	readonly #serializer = new HeadlessSerializeAddon();
	readonly #snapshotScrollback: number;

	constructor(
		geometry: TerminalGeometry,
		options: { readonly scrollbackRows?: number; readonly snapshotScrollbackRows?: number } = {},
	) {
		const scrollback = options.scrollbackRows ?? TERMINAL_DEFAULTS.replay.scrollbackRows;
		this.#snapshotScrollback = options.snapshotScrollbackRows ?? scrollback;
		this.#terminal = new Terminal({
			allowProposedApi: true,
			cols: geometry.cols,
			rows: geometry.rows,
			scrollback,
		});
		this.#terminal.loadAddon(this.#serializer);
	}

	get geometry(): TerminalGeometry {
		return { rows: this.#terminal.rows, cols: this.#terminal.cols };
	}

	get activeBuffer(): "normal" | "alternate" {
		return this.#terminal.buffer.active.type;
	}

	get cursor(): { readonly row: number; readonly col: number } {
		return {
			row: this.#terminal.buffer.active.cursorY,
			col: this.#terminal.buffer.active.cursorX,
		};
	}

	write(data: Uint8Array | string): Promise<void> {
		return new Promise((resolve) => this.#terminal.write(data, resolve));
	}

	resize(geometry: TerminalGeometry): void {
		this.#terminal.resize(geometry.cols, geometry.rows);
	}

	snapshot(sequence: number): TerminalSnapshot {
		const serialized = this.#serializer.serialize(this.#snapshotScrollback);
		return {
			format: "xterm-ansi",
			formatVersion: 1,
			encoding: "base64",
			data: Buffer.from(serialized, "utf8").toString("base64"),
			sequence,
			rows: this.#terminal.rows,
			cols: this.#terminal.cols,
		};
	}

	currentScreenText(): string {
		const buffer = this.#terminal.buffer.active;
		const start = buffer.type === "normal" ? buffer.baseY : 0;
		return logicalLines(buffer, start, Math.min(buffer.length, start + this.#terminal.rows))
			.join("\n")
			.trimEnd();
	}

	allText(): string {
		const buffer = this.#terminal.buffer.active;
		return logicalLines(buffer, 0, buffer.length).join("\n").trimEnd();
	}

	dispose(): void {
		this.#terminal.dispose();
	}
}

interface TerminalBufferView {
	readonly length: number;
	getLine(row: number): { readonly isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined;
}

function logicalLines(buffer: TerminalBufferView, start: number, end: number): string[] {
	const lines: string[] = [];
	for (let row = start; row < end; row += 1) {
		const line = buffer.getLine(row);
		if (!line) continue;
		const text = line.translateToString(true);
		if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
		else lines.push(text);
	}
	return lines;
}
