import { describe, expect, it, vi } from "vitest";
import { applyTerminalTheme, terminalTheme } from "../features/terminal/model/terminal-theme.ts";

const ANSI_KEYS = [
	"black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
	"brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

describe("Terminal theme", () => {
	it("provides complete, distinct light and dark xterm palettes", () => {
		const light = terminalTheme("light");
		const dark = terminalTheme("dark");
		expect(light.background).not.toBe(dark.background);
		expect(light.foreground).not.toBe(dark.foreground);
		for (const key of ANSI_KEYS) {
			expect(light[key]).toBeTypeOf("string");
			expect(dark[key]).toBeTypeOf("string");
		}
	});

	it("updates only the existing terminal theme option", () => {
		const assign = vi.fn();
		const options = {} as { theme?: ReturnType<typeof terminalTheme> };
		Object.defineProperty(options, "theme", { set: assign });
		applyTerminalTheme({ options }, "dark");
		expect(assign).toHaveBeenCalledOnce();
		expect(assign).toHaveBeenCalledWith(terminalTheme("dark"));
	});
});
