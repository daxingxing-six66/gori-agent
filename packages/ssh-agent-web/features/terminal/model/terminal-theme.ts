import type { ITheme } from "@xterm/xterm";
import type { ResolvedTheme } from "@/features/theme/model/theme";

const LIGHT_TERMINAL_THEME: Readonly<ITheme> = {
	background: "#edf1e7",
	foreground: "#2e3c31",
	cursor: "#397b5c",
	cursorAccent: "#edf1e7",
	selectionBackground: "#cfe2d7",
	selectionForeground: "#1e3027",
	selectionInactiveBackground: "#dde6e0",
	scrollbarSliderBackground: "#9aa29b55",
	scrollbarSliderHoverBackground: "#747c7577",
	scrollbarSliderActiveBackground: "#5d655f99",
	black: "#343834",
	red: "#a94f59",
	green: "#327a59",
	yellow: "#91661f",
	blue: "#3d6e9f",
	magenta: "#805d94",
	cyan: "#27787b",
	white: "#d9dbd6",
	brightBlack: "#7d847e",
	brightRed: "#c7656e",
	brightGreen: "#46946f",
	brightYellow: "#ad8139",
	brightBlue: "#5787b7",
	brightMagenta: "#9874aa",
	brightCyan: "#3c9396",
	brightWhite: "#fafbf8",
};

const DARK_TERMINAL_THEME: Readonly<ITheme> = {
	background: "#101b1a",
	foreground: "#d6e3dc",
	cursor: "#74b995",
	cursorAccent: "#101b1a",
	selectionBackground: "#355f49",
	selectionForeground: "#edf3ef",
	selectionInactiveBackground: "#2a4436",
	scrollbarSliderBackground: "#aab5ad33",
	scrollbarSliderHoverBackground: "#b8c4bb55",
	scrollbarSliderActiveBackground: "#c5d1c777",
	black: "#232723",
	red: "#df7f87",
	green: "#78c99b",
	yellow: "#d6b56c",
	blue: "#80acd4",
	magenta: "#b99acb",
	cyan: "#79c4c4",
	white: "#d4d8d3",
	brightBlack: "#747c75",
	brightRed: "#ee969d",
	brightGreen: "#91d8af",
	brightYellow: "#e5c880",
	brightBlue: "#98bee0",
	brightMagenta: "#cbb0d8",
	brightCyan: "#91d2d1",
	brightWhite: "#f2f5f2",
};

const CONTRAST_TERMINAL_THEME: Readonly<ITheme> = {
	...DARK_TERMINAL_THEME,
	background: "#252c29",
	foreground: "#dae3dd",
	cursor: "#92bea3",
	cursorAccent: "#252c29",
	selectionBackground: "#425e4d",
	selectionInactiveBackground: "#36453c",
};

const ION_TERMINAL_THEME: Readonly<ITheme> = {
	background: "#080e18",
	foreground: "#c6d8ef",
	cursor: "#79baff",
	cursorAccent: "#080e18",
	selectionBackground: "#244876",
	selectionForeground: "#edf5ff",
	selectionInactiveBackground: "#1c2d48",
	scrollbarSliderBackground: "#79baff33",
	scrollbarSliderHoverBackground: "#79baff55",
	scrollbarSliderActiveBackground: "#79baff88",
	black: "#182035",
	red: "#ff8498",
	green: "#79baff",
	yellow: "#f2b56b",
	blue: "#8ba4ff",
	magenta: "#be9bff",
	cyan: "#a7d1ff",
	white: "#c6d8ef",
	brightBlack: "#64738d",
	brightRed: "#ffa5b4",
	brightGreen: "#9bceff",
	brightYellow: "#ffd29b",
	brightBlue: "#b1c0ff",
	brightMagenta: "#d8c1ff",
	brightCyan: "#d0e7ff",
	brightWhite: "#f3f7ff",
};

export function terminalTheme(theme: ResolvedTheme): Readonly<ITheme> {
	if (theme === "ion") return ION_TERMINAL_THEME;
	if (theme === "contrast") return CONTRAST_TERMINAL_THEME;
	return theme === "dark" ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
}

export function applyTerminalTheme(
	terminal: { options: { theme?: ITheme } },
	theme: ResolvedTheme,
): void {
	terminal.options.theme = terminalTheme(theme);
}
