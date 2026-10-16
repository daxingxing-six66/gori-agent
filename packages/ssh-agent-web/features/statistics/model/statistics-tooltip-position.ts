export interface StatisticsTooltipPoint { x: number; y: number }
interface Size { width: number; height: number }

export function positionStatisticsTooltip(anchor: StatisticsTooltipPoint, tooltip: Size, viewport: Size): StatisticsTooltipPoint {
	const gap = 16, inset = 12;
	const left = anchor.x + gap + tooltip.width <= viewport.width - inset ? anchor.x + gap : anchor.x - gap - tooltip.width;
	const top = anchor.y + gap + tooltip.height <= viewport.height - inset ? anchor.y + gap : anchor.y - gap - tooltip.height;
	return {
		x: Math.max(inset, Math.min(left, viewport.width - tooltip.width - inset)),
		y: Math.max(inset, Math.min(top, viewport.height - tooltip.height - inset)),
	};
}
