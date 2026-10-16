import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatisticsTooltip } from "../features/statistics/components/statistics-tooltip";
import { positionStatisticsTooltip } from "../features/statistics/model/statistics-tooltip-position";

describe("statistics floating details", () => {
	it("follows the pointer with space for the cursor", () => {
		expect(positionStatisticsTooltip({ x: 100, y: 200 }, { width: 280, height: 210 }, { width: 1280, height: 800 })).toEqual({ x: 116, y: 216 });
	});

	it("flips to the left and above near the bottom right corner", () => {
		expect(positionStatisticsTooltip({ x: 980, y: 700 }, { width: 280, height: 200 }, { width: 1000, height: 800 })).toEqual({ x: 684, y: 484 });
	});

	it.each([{ x: 1, y: 1 }, { x: 318, y: 518 }, { x: -40, y: -20 }, { x: 400, y: 600 }])("keeps the full tooltip inside a narrow viewport at $x, $y", (anchor) => {
		const position = positionStatisticsTooltip(anchor, { width: 280, height: 180 }, { width: 320, height: 520 });
		expect(position.x).toBeGreaterThanOrEqual(12);
		expect(position.y).toBeGreaterThanOrEqual(12);
		expect(position.x + 280).toBeLessThanOrEqual(308);
		expect(position.y + 180).toBeLessThanOrEqual(508);
	});

	it("exposes a described tooltip without a native title popup", () => {
		const html = renderToStaticMarkup(<StatisticsTooltip id="day-details" anchor={{ x: 20, y: 30 }} title="2026-10-16"><span>123,456 Token</span></StatisticsTooltip>);
		expect(html).toContain('role="tooltip"');
		expect(html).toContain('id="day-details"');
		expect(html).toContain("2026-10-16");
		expect(html).toContain("123,456 Token");
		expect(html).not.toContain('title="');
	});
});
