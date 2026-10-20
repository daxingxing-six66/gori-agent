"use client";
import { useCallback, useRef, useState } from "react";

export interface DiagnoseView { page: "records" | "conclusion"; expanded: Record<number, boolean>; recordsScroll: number; conclusionScroll: number; seenSequence: number }
const initialView = (): DiagnoseView => ({ page: "records", expanded: {}, recordsScroll: 0, conclusionScroll: 0, seenSequence: 0 });
export function useDiagnoseView(sessionId: string) {
	const saved = useRef<{ sessionId: string; views: Map<string, DiagnoseView> }>({ sessionId, views: new Map() });
	if (saved.current.sessionId !== sessionId) saved.current = { sessionId, views: new Map() };
	const [, render] = useState(0);
	const get = useCallback((id: string) => {
		let view = saved.current.views.get(id);
		if (!view) { view = initialView(); saved.current.views.set(id, view); }
		return view;
	}, []);
	const update = useCallback((id: string, patch: Partial<DiagnoseView>, notify = true) => {
		saved.current.views.set(id, { ...get(id), ...patch });
		if (notify) render((value) => value + 1);
	}, [get]);
	return { get, update };
}
