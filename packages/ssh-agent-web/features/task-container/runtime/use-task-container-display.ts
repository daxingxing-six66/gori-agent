"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { TaskContainerDisplayMode } from "../model/task-container-display";

/** Display preferences belong to this mounted scope, independently of task execution. */
export function useTaskContainerDisplay(scopeId: string, hasTasks: boolean) {
	const scope = useMemo(() => ({ scopeId }), [scopeId]);
	const [state, setState] = useState<{ scope: typeof scope; mode: TaskContainerDisplayMode }>({ scope, mode: "docked" });
	const mode = hasTasks && state.scope === scope ? state.mode : "docked";

	useEffect(() => {
		if (!hasTasks) setState((current) => current.scope === scope && current.mode === "docked"
			? current : { scope, mode: "docked" });
	}, [hasTasks, scope]);

	const changeMode = useCallback((mode: TaskContainerDisplayMode) => {
		if (hasTasks) setState({ scope, mode });
	}, [hasTasks, scope]);
	const reveal = useCallback(() => {
		setState((current) => ({ scope, mode: current.scope === scope && current.mode === "fullscreen" ? "fullscreen" : "docked" }));
	}, [scope]);

	return { mode, changeMode, reveal };
}
