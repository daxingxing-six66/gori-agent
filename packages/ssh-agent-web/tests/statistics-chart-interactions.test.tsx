import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let driver: ChartHooks;
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
	useState: (initial: unknown) => driver.state(initial),
	useEffect: () => undefined,
	useMemo: (compute: () => unknown) => compute(),
	useRef: (current: unknown) => ({ current }),
	useId: () => "chart-tooltip",
	useCallback: <T,>(callback: T) => callback,
}));
vi.mock("react-intl", () => ({ useIntl: () => ({
	formatMessage: ({ id }: { id: string }) => id,
	formatNumber: (value: number) => String(value),
	formatDate: (value: string | number) => String(value),
}) }));

import { StatisticsTrend } from "../features/statistics/components/statistics-trend";
import { StatisticsCalendar } from "../features/statistics/components/statistics-calendar";
import { StatisticsTooltip } from "../features/statistics/components/statistics-tooltip";
import type { StatisticsDay } from "../features/statistics/model/statistics";

class ChartHooks {
	private values: unknown[] = [];
	private index = 0;
	state<T>(initial: T): [T, (next: T | ((current: T) => T)) => void] {
		const index = this.index++;
		if (!(index in this.values)) this.values[index] = initial;
		return [this.values[index] as T, (next) => {
			this.values[index] = typeof next === "function" ? (next as (current: T) => T)(this.values[index] as T) : next;
		}];
	}
	render(render: () => ReactNode) { this.index = 0; return nodes(render()); }
}
type Node = ReactElement<Record<string, unknown>>;
function nodes(node: ReactNode): Node[] {
	if (Array.isArray(node)) return node.flatMap(nodes);
	if (!isValidElement<Record<string, unknown>>(node)) return [];
	return [node, ...nodes(node.props.children as ReactNode)];
}
function fire(node: Node, name: string, event: unknown = { clientX: 100, clientY: 200 }) {
	const callback = node.props[name];
	expect(callback).toBeTypeOf("function");
	(callback as (event: unknown) => void)(event);
}
const day = (date: string, tokens: number, runs = 0): StatisticsDay => ({ date, runs, active: tokens > 0 || runs > 0,
	usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, calls: tokens > 0 ? 1 : 0,
		usageSamples: tokens > 0 ? 1 : 0, costSamples: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const tooltip = (tree: Node[]) => tree.find((node) => node.type === StatisticsTooltip);
const bar = (tree: Node[], index: number) => tree.filter((node) => node.type === "g" && node.props.role === "img")[index];
const cell = (tree: Node[], date: string) => tree.find((node) => node.props.className === "stats-calendar-day" && node.key === date)!;
const focusEvent = { currentTarget: { getBoundingClientRect: () => ({ right: 150, top: 200 }) } };

beforeEach(() => { driver = new ChartHooks(); });

describe("chart detail visibility", () => {
	it("opens a bar detail only on pointer entry, without opening on keyboard focus", () => {
		const render = () => driver.render(() => StatisticsTrend({ days: [day("2026-10-15", 100), day("2026-10-16", 200)] }));
		expect(tooltip(render())).toBeUndefined();
		fire(bar(render(), 0), "onFocus", focusEvent);
		expect(tooltip(render())).toBeUndefined();
		fire(bar(render(), 0), "onPointerEnter");
		expect(tooltip(render())?.props.title).toBe("2026-10-15");
	});

	it("follows pointer movement, unmounts on leave and mounts fresh details for another bar", () => {
		const render = () => driver.render(() => StatisticsTrend({ days: [day("2026-10-15", 100), day("2026-10-16", 200)] }));
		fire(bar(render(), 0), "onPointerEnter");
		const firstKey = tooltip(render())?.key;
		fire(bar(render(), 0), "onPointerMove", { clientX: 130, clientY: 240 });
		expect(tooltip(render())?.props.anchor).toEqual({ x: 130, y: 240 });
		fire(bar(render(), 0), "onPointerLeave");
		expect(tooltip(render())).toBeUndefined();
		fire(bar(render(), 1), "onPointerEnter");
		expect(tooltip(render())?.props.title).toBe("2026-10-16");
		expect(tooltip(render())?.key).not.toBe(firstKey);
	});

	const calendarDays = [day("2026-10-14", 0), day("2026-10-15", 400), day("2026-10-16", 0, 2)];
	const renderCalendar = () => driver.render(() => StatisticsCalendar({
		calendar: { year: 2026, from: 0, to: 1, days: calendarDays, activeDays: 2, currentStreak: 2, longestStreak: 2, peakTokens: 400 },
		generatedAt: Date.parse("2026-10-16T12:00:00Z"), timeZone: "Asia/Shanghai", years: [2026], onYear: () => undefined,
	}));

	it("does not render empty calendar details on hover, focus or click", () => {
		for (const name of ["onPointerEnter", "onPointerMove", "onFocus", "onClick"]) {
			fire(cell(renderCalendar(), "2026-10-14"), name, { ...focusEvent, clientX: 100, clientY: 200 });
			expect(tooltip(renderCalendar())).toBeUndefined();
		}
	});

	it("clears a previous calendar detail when the pointer enters an empty cell", () => {
		fire(cell(renderCalendar(), "2026-10-15"), "onPointerEnter");
		expect(tooltip(renderCalendar())?.props.title).toBe("2026-10-15");
		fire(cell(renderCalendar(), "2026-10-14"), "onPointerEnter");
		expect(tooltip(renderCalendar())).toBeUndefined();
	});

	it("keeps calendar details for a day with runs even when token usage is zero", () => {
		fire(cell(renderCalendar(), "2026-10-16"), "onPointerEnter");
		expect(tooltip(renderCalendar())?.props.title).toBe("2026-10-16");
	});
});
