"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deploymentApi } from "../api/deployment-api";
import { isDeploymentTask, type DeploymentTask } from "../model/deployment-task";
import type { DeploymentRun } from "../model/deployment";

/** Durable mode facts, independent of the selected or closed task page. */
export function useDeploymentTasks(sessionId: string) {
	const scope = useMemo(() => ({ sessionId }), [sessionId]);
	const currentScope = useRef<typeof scope | null>(scope);
	currentScope.current = scope;
	const [state, setState] = useState<{ scope: typeof scope; activeId: string | null; tasks: Record<string, DeploymentTask> }>({ scope, activeId: null, tasks: {} });
	const requestVersion = useRef(0);
	const latestRequest = useRef<{ version: number; result: Promise<DeploymentTask | null | undefined> } | null>(null);
	const [failure, setFailure] = useState<{ scope: typeof scope; message: string | null }>({ scope, message: null });
	const [readyScope, setReadyScope] = useState<typeof scope | null>(null);
	const accept = useCallback((task: DeploymentTask, active = false) => {
		if (currentScope.current !== scope || task.deployment.sessionId !== sessionId) return;
		setState((prior) => {
			const current = prior.scope === scope ? prior : { scope, activeId: null, tasks: {} };
			const saved = current.tasks[task.deployment.id];
			if (saved?.deployment.outcome && !task.deployment.outcome || saved && (saved.run?.updatedAt ?? 0) > (task.run?.updatedAt ?? 0)) return current;
			return { scope, tasks: { ...current.tasks, [task.deployment.id]: task },
				activeId: task.deployment.outcome && current.activeId === task.deployment.id ? null : active ? task.deployment.id : current.activeId };
		});
	}, [scope, sessionId]);
	const refresh = useCallback((): Promise<DeploymentTask | null | undefined> => {
		const version = ++requestVersion.current;
		// SSE can replace this lookup. Its callers still need the newest mode confirmation.
		const supersedingResult = () => currentScope.current === scope && latestRequest.current
			&& latestRequest.current.version === requestVersion.current && latestRequest.current.version > version
			? latestRequest.current.result : undefined;
		const result = (async () => {
			let task: DeploymentTask | null;
			try { task = await deploymentApi.mode(sessionId); }
			catch (error) {
				if (currentScope.current !== scope || version !== requestVersion.current) return supersedingResult();
				setFailure({ scope, message: error instanceof Error ? error.message : String(error) });
				throw error;
			}
			if (currentScope.current !== scope || version !== requestVersion.current) return supersedingResult();
			setReadyScope(scope);
			setFailure({ scope, message: null });
			if (task) accept(task, true);
			else setState((prior) => prior.scope === scope ? { ...prior, activeId: null } : { scope, activeId: null, tasks: {} });
			return task;
		})();
		latestRequest.current = { version, result };
		return result;
	}, [accept, scope, sessionId]);
	const receive = useCallback((value: unknown) => {
		if (!isDeploymentTask(value) || value.deployment.sessionId !== sessionId) return;
		++requestVersion.current;
		accept(value);
		// Starts may arrive late; only the server mode query chooses the active identity.
		if (!value.deployment.outcome) void refresh().catch(() => undefined);
	}, [accept, refresh, sessionId]);
	const get = useCallback(async (id: string) => {
		const task = await deploymentApi.task(sessionId, id);
		accept(task);
		return task;
	}, [accept, sessionId]);
	const updateRun = useCallback((run: DeploymentRun) => {
		if (currentScope.current !== scope || run.sessionId !== sessionId) return;
		setState((current) => {
			const task = current.scope === scope ? current.tasks[run.discussionId ?? run.id] : undefined;
			if (!task || task.run && task.run.updatedAt > run.updatedAt || task.deployment.outcome && run.status !== task.deployment.outcome) return current;
			const stage = (["build", "upload", "restart", "verify"] as const).find((name) => ["running", "failed"].includes(run.stages[name].status))
				?? (["prepare", "build", "upload", "restart", "verify"] as const).filter((name) => run.stages[name].finishedAt !== undefined)
					.sort((a, b) => (run.stages[a].finishedAt ?? 0) - (run.stages[b].finishedAt ?? 0)).at(-1) ?? "prepare";
			return { ...current, tasks: { ...current.tasks, [task.deployment.id]: { ...task, run, stage, stageStatus: run.stages[stage].status,
				phase: task.deployment.outcome ? "finished" : run.status === "preparing" ? "review" : "execution" } } };
		});
	}, [scope, sessionId]);
	useEffect(() => {
		currentScope.current = scope;
		void refresh().catch(() => undefined);
		return () => { ++requestVersion.current; if (currentScope.current === scope) currentScope.current = null; };
	}, [refresh, scope]);
	const tasks = state.scope === scope ? state.tasks : {};
	return { active: state.scope === scope && state.activeId ? tasks[state.activeId] ?? null : null, tasks,
		error: failure.scope === scope ? failure.message : null, ready: readyScope === scope, accept, refresh, receive, get, updateRun };
}
