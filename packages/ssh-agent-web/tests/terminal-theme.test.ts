import { describe, expect, it, vi } from "vitest";
import { applyTerminalTheme, terminalTheme } from "../features/terminal/model/terminal-theme.ts";

const ANSI_KEYS = [
	"black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
	"brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

describe("Terminal theme", () => {
	it("provides complete, distinct palettes for all three visual themes", () => {
		const light = terminalTheme("light");
		const dark = terminalTheme("dark");
		const contrast = terminalTheme("contrast");
		expect(light.background).not.toBe(dark.background);
		expect(light.foreground).not.toBe(dark.foreground);
		expect(contrast.background).not.toBe(light.background);
		expect(contrast.background).not.toBe(dark.background);
		for (const key of ANSI_KEYS) {
			expect(light[key]).toBeTypeOf("string");
			expect(dark[key]).toBeTypeOf("string");
			expect(contrast[key]).toBeTypeOf("string");
		}
	});

	it.each(["light", "dark", "contrast"] as const)("updates only the existing terminal theme option for %s", (theme) => {
		const assign = vi.fn();
		const options = {} as { theme?: ReturnType<typeof terminalTheme> };
		Object.defineProperty(options, "theme", { set: assign });
		applyTerminalTheme({ options }, theme);
		expect(assign).toHaveBeenCalledOnce();
		expect(assign).toHaveBeenCalledWith(terminalTheme(theme));
	});
});
