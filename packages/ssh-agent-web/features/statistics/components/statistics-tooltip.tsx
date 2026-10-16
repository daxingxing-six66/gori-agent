"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { positionStatisticsTooltip, type StatisticsTooltipPoint } from "../model/statistics-tooltip-position";

export function useStatisticsTooltip() {
	const id = useId();
	const [anchor, setAnchor] = useState<StatisticsTooltipPoint | null>(null);
	const hide = useCallback(() => setAnchor(null), []);
	const open = anchor !== null;
	useEffect(() => {
		if (!open) return;
		const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
		window.addEventListener("scroll", hide, true);
		window.addEventListener("resize", hide);
		window.addEventListener("keydown", dismiss);
		return () => {
			window.removeEventListener("scroll", hide, true);
			window.removeEventListener("resize", hide);
			window.removeEventListener("keydown", dismiss);
		};
	}, [open, hide]);
	return {
		id, anchor, hide,
		follow: (event: { clientX: number; clientY: number }) => setAnchor({ x: event.clientX, y: event.clientY }),
		focus: (element: Element) => {
			const rect = element.getBoundingClientRect();
			setAnchor({ x: rect.right, y: rect.top });
		},
	};
}

export function StatisticsTooltip({ id, anchor, title, children }: {
	id: string; anchor: StatisticsTooltipPoint; title: string; children: ReactNode;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState(anchor);
	useLayoutEffect(() => {
		if (!ref.current) return;
		const rect = ref.current.getBoundingClientRect();
		const next = positionStatisticsTooltip(anchor, rect, { width: document.documentElement.clientWidth, height: window.innerHeight });
		setPosition((current) => current.x === next.x && current.y === next.y ? current : next);
	}, [anchor, children]);
	return <div ref={ref} id={id} role="tooltip" className="stats-floating-tooltip" style={{ left: position.x, top: position.y }}>
		<p className="stats-tooltip-title">{title}</p>{children}
	</div>;
}
