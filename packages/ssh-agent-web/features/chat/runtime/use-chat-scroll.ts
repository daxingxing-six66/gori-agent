"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type TouchEvent, type WheelEvent } from "react";
import type { ChatTimelineEntry } from "../model/chat-runtime-state";
import { captureChatScrollAnchor, ChatScrollController, restoreChatScrollAnchor, type ChatScrollAnchor } from "./chat-scroll-controller";

/** Owns viewport following only; message retrieval and Chat/Agent state stay with their existing owners. */
export function useChatScroll({ sessionId, loading, timeline, showActivity, present = true, loadingOlderMessages = false }: {
	sessionId: string;
	loading: boolean;
	timeline: readonly ChatTimelineEntry[];
	showActivity: boolean;
	present?: boolean;
	loadingOlderMessages?: boolean;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const scope = useMemo(() => ({ sessionId, controller: new ChatScrollController() }), [sessionId]);
	const { controller } = scope;
	const [button, setButton] = useState({ controller, visible: false });
	const historyAnchor = useRef<{ controller: ChatScrollController; anchor: ChatScrollAnchor } | null>(null);
	const touchY = useRef<{ controller: ChatScrollController; y: number } | null>(null);
	const updateButton = useCallback(() => {
		const visible = scrollRef.current !== null && controller.showReturnToBottom(scrollRef.current);
		setButton((current) => current.controller === controller && current.visible === visible ? current : { controller, visible });
	}, [controller]);
	const pause = useCallback(() => {
		if (!scrollRef.current) return;
		controller.pause(scrollRef.current);
		updateButton();
	}, [controller, updateButton]);
	useLayoutEffect(() => {
		const viewport = scrollRef.current;
		if (!present || !viewport) return;
		const current = historyAnchor.current;
		if (controller.followNewContent && current?.controller === controller) historyAnchor.current = null;
		else if (current?.controller === controller) {
			restoreChatScrollAnchor(viewport, current.anchor);
			controller.rememberPosition(viewport);
		}
		controller.contentChanged(viewport, loading);
		updateButton();
	}, [controller, loading, loadingOlderMessages, present, showActivity, timeline, updateButton]);

	const handleScroll = useCallback(() => {
		if (!scrollRef.current) return;
		// A loading placeholder can clamp scrollTop without user input during Session changes.
		if (loading) controller.rememberPosition(scrollRef.current);
		else controller.scrolled(scrollRef.current);
		if (historyAnchor.current?.controller === controller) {
			const anchor = controller.followNewContent ? null : captureChatScrollAnchor(scrollRef.current);
			historyAnchor.current = anchor ? { controller, anchor } : null;
		}
		updateButton();
	}, [controller, loading, updateButton]);
	const scrollToBottom = useCallback(() => {
		if (!scrollRef.current) return;
		if (historyAnchor.current?.controller === controller) historyAnchor.current = null;
		controller.resume(scrollRef.current);
		updateButton();
	}, [controller, updateButton]);
	const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
		if (!event.ctrlKey && event.deltaY < 0 && Math.abs(event.deltaY) >= Math.abs(event.deltaX)) pause();
	};
	const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
		touchY.current = event.touches.length === 1 ? { controller, y: event.touches[0].clientY } : null;
	};
	const handleTouchMove = (event: TouchEvent<HTMLDivElement>) => {
		const current = event.touches.length === 1 ? event.touches[0].clientY : null;
		if (current !== null && touchY.current?.controller === controller && current > touchY.current.y) pause();
		touchY.current = current === null ? null : { controller, y: current };
	};
	const handleTouchEnd = () => { touchY.current = null; };
	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
		if (event.target instanceof Element && event.target.closest("input, textarea, select, button, [contenteditable]:not([contenteditable='false']), [role='textbox']")) return;
		if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home" || event.key === " " && event.shiftKey) pause();
	};
	const preserveHistoryPosition = useCallback(() => {
		const anchor = scrollRef.current ? captureChatScrollAnchor(scrollRef.current) : null;
		historyAnchor.current = anchor ? { controller, anchor } : null;
	}, [controller]);
	const clearHistoryPosition = useCallback(() => { if (historyAnchor.current?.controller === controller) historyAnchor.current = null; }, [controller]);
	return { scrollRef, showReturnToBottom: button.controller === controller && button.visible, scrollToBottom,
		handleScroll, handleWheel, handleTouchStart, handleTouchMove, handleTouchEnd, handleKeyDown,
		preserveHistoryPosition, clearHistoryPosition };
}
