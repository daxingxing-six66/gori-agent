"use client";

import { useCallback, useLayoutEffect, useRef, type RefObject, type UIEvent } from "react";

/** Keeps the shared navigation viewport across page-owned sidebar mounts. */
export function useSidebarScroll(position: RefObject<number>, ready: boolean, activeSessionId?: string) {
	const container = useRef<HTMLDivElement | null>(null);
	const restored = useRef(false);
	const locatedSession = useRef<string | undefined>(undefined);
	const ref = useCallback((element: HTMLDivElement | null) => {
		const previous = container.current;
		if (previous && restored.current && previous.clientHeight > 0) position.current = previous.scrollTop;
		container.current = element;
		restored.current = false;
		locatedSession.current = undefined;
	}, [position]);

	// Run after each layout so delayed tree loading and reopening a hidden drawer can restore too.
	useLayoutEffect(() => {
		const element = container.current;
		if (!ready || !element || element.clientHeight === 0) return;
		if (!restored.current) {
			element.scrollTop = position.current;
			restored.current = true;
		}
		if (activeSessionId !== locatedSession.current) {
			const selected = element.querySelector<HTMLElement>('.sidebar-session-link[aria-current="page"]');
			if (activeSessionId && !selected) return;
			if (selected) {
				const viewport = element.getBoundingClientRect();
				const row = selected.getBoundingClientRect();
				if (row.top < viewport.top) element.scrollTop += row.top - viewport.top;
				else if (row.bottom > viewport.bottom) element.scrollTop += row.bottom - viewport.bottom;
			}
			locatedSession.current = activeSessionId;
		}
		position.current = element.scrollTop;
	});

	const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
		if (restored.current && event.currentTarget.clientHeight > 0) position.current = event.currentTarget.scrollTop;
	}, [position]);
	return { ref, onScroll };
}
