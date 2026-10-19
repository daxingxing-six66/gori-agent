import { describe, expect, it, vi } from "vitest";
import { applyTerminalTheme, terminalTheme } from "../features/terminal/model/terminal-theme.ts";

const ANSI_KEYS = [
	"black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
	"brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

describe("Terminal theme", () => {
	it("provides complete, distinct palettes for all four visual themes", () => {
		const light = terminalTheme("light");
		const dark = terminalTheme("dark");
		const contrast = terminalTheme("contrast");
		const ion = terminalTheme("ion");
		expect(light.background).not.toBe(dark.background);
		expect(light.foreground).not.toBe(dark.foreground);
		expect(contrast.background).not.toBe(light.background);
		expect(contrast.background).not.toBe(dark.background);
		expect(ion.background).not.toBe(light.background);
		expect(ion.background).not.toBe(dark.background);
		expect(ion.background).not.toBe(contrast.background);
		for (const key of ANSI_KEYS) {
			expect(light[key]).toBeTypeOf("string");
			expect(dark[key]).toBeTypeOf("string");
			expect(contrast[key]).toBeTypeOf("string");
			expect(ion[key]).toBeTypeOf("string");
		}
	});

	it("uses the observation surface and blue ANSI success colors for ION", () => {
		const ion = terminalTheme("ion");
		expect(ion).toMatchObject({
			background: "#080e18",
			foreground: "#c6d8ef",
			cursor: "#79baff",
			green: "#79baff",
			brightGreen: "#9bceff",
			cyan: "#a7d1ff",
			brightCyan: "#d0e7ff",
		});
		for (const color of Object.values(ion)) {
			if (typeof color !== "string" || !/^#[\da-f]{6}$/i.test(color)) continue;
			const red = Number.parseInt(color.slice(1, 3), 16);
			const green = Number.parseInt(color.slice(3, 5), 16);
			const blue = Number.parseInt(color.slice(5, 7), 16);
			expect(green > red && green > blue).toBe(false);
		}
	});

	it.each(["light", "dark", "contrast", "ion"] as const)("updates only the existing terminal theme option for %s", (theme) => {
		const assign = vi.fn();
		const options = {} as { theme?: ReturnType<typeof terminalTheme> };
		Object.defineProperty(options, "theme", { set: assign });
		applyTerminalTheme({ options }, theme);
		expect(assign).toHaveBeenCalledOnce();
		expect(assign).toHaveBeenCalledWith(terminalTheme(theme));
	});

	it("switches an attached terminal into and out of ION while retaining viewport options", () => {
		const terminal = {
			options: { theme: terminalTheme("dark"), cursorBlink: true, fontSize: 12, scrollback: 5000 },
			rows: 24,
			cols: 80,
			clear: vi.fn(),
			resize: vi.fn(),
			dispose: vi.fn(),
		};
		const options = terminal.options;
		applyTerminalTheme(terminal, "ion");
		expect(terminal.options.theme).toBe(terminalTheme("ion"));
		applyTerminalTheme(terminal, "light");
		expect(terminal.options).toBe(options);
		expect(terminal.options).toMatchObject({ theme: terminalTheme("light"), cursorBlink: true, fontSize: 12, scrollback: 5000 });
		expect([terminal.rows, terminal.cols]).toEqual([24, 80]);
		expect(terminal.clear).not.toHaveBeenCalled();
		expect(terminal.resize).not.toHaveBeenCalled();
		expect(terminal.dispose).not.toHaveBeenCalled();
	});
});
