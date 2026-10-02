"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/features/i18n/components/locale-context";
import { apiUrlWithLocale } from "@/shared/api/client";
import { deploymentApi } from "../api/deployment-api";
import { isDeploymentRun, type DeploymentDiscovery, type DeploymentRemoteStage, type DeploymentRun } from "../model/deployment";
import { addDeploymentHistoryRun, applyDeploymentHistoryPage, emptyDeploymentHistory } from "../model/deployment-history";

type PanelMode = "closed" | "current" | "history";

export function useDeployment(sessionId: string, workspaceId: string | undefined) {
	const { locale } = useLocale();
	const [panelMode, setPanelMode] = useState<PanelMode>("closed");
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [discovery, setDiscovery] = useState<DeploymentDiscovery | null>(null);
	const [run, setRun] = useState<DeploymentRun | null>(null);
	const [historyState, setHistoryState] = useState(emptyDeploymentHistory);
	const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const sessionScopeRef = useRef<{ sessionId: string } | null>(null);
	const selectionVersionRef = useRef(0);
	const runRef = useRef<DeploymentRun | null>(null);
	const olderHistoryRequestRef = useRef<{ sessionId: string; cursor: string } | null>(null);
	useEffect(() => { runRef.current = run; }, [run]);
	const applyRun = useCallback((value: DeploymentRun) => {
		setRun((current) => current?.id === value.id && current.updatedAt > value.updatedAt ? current : value);
		setHistoryState((current) => addDeploymentHistoryRun(current, value));
	}, []);

	const refresh = useCallback(async () => {
		const scope = sessionScopeRef.current;
		const selectionVersion = selectionVersionRef.current;
		const [value, result] = await Promise.all([deploymentApi.discover(sessionId), deploymentApi.history(sessionId).then(
			(page) => ({ page, error: null }),
			(failure: unknown) => ({ page: null, error: message(failure) }),
		)]);
		if (sessionScopeRef.current !== scope) return value;
		setDiscovery(value);
		const page = result.page;
		if (page) setHistoryState((current) => applyDeploymentHistoryPage(current, page));
		if (result.error) setError(result.error);
		if (selectionVersionRef.current === selectionVersion) setRun((current) => {
			if (!current) return value.latest;
			const fresh = result.page?.runs.find((candidate) => candidate.id === current.id) ?? (value.latest?.id === current.id ? value.latest : null);
			return fresh && fresh.updatedAt >= current.updatedAt ? fresh : current;
		});
		return value;
	}, [sessionId]);

	useEffect(() => {
		let disposed = false;
		const scope = { sessionId };
		sessionScopeRef.current = scope;
		const selectionVersion = ++selectionVersionRef.current;
		setPanelMode("closed");
		setRun(null);
		setHistoryState(emptyDeploymentHistory());
		setLoadingOlderHistory(false);
		olderHistoryRequestRef.current = null;
		setDiscovery(null);
		setError(null);
		setBusy(false);
		setLoading(false);
		void deploymentApi.discover(sessionId).then((value) => {
			if (disposed) return;
			setDiscovery(value);
			const latest = value.latest;
			if (latest && selectionVersionRef.current === selectionVersion) {
				setRun((current) => current && current.id === latest.id && current.updatedAt > latest.updatedAt ? current : latest);
				if (latest.status === "preparing" || latest.status === "running") setPanelMode("current");
			}
		}).catch((failure) => { if (!disposed) setError(message(failure)); });
		void deploymentApi.history(sessionId).then((page) => {
			if (!disposed) {
				setHistoryState((current) => applyDeploymentHistoryPage(current, page));
			}
		}).catch((failure) => { if (!disposed) setError(message(failure)); });
		return () => {
			disposed = true;
			if (sessionScopeRef.current === scope) sessionScopeRef.current = null;
		};
	}, [sessionId]);

	useEffect(() => {
		if (!workspaceId) return;
		let disposed = false;
		const scope = sessionScopeRef.current;
		const stream = new EventSource(apiUrlWithLocale(`/api/workspaces/${encodeURIComponent(workspaceId)}/events?topics=deployments`, locale));
		const updated = (event: Event) => {
			if (disposed || sessionScopeRef.current !== scope) return;
			if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
			let value: unknown;
			try { value = JSON.parse(event.data); } catch { return; }
			if (!isDeploymentRun(value) || value.sessionId !== sessionId || value.workspaceId !== workspaceId) return;
			setHistoryState((current) => addDeploymentHistoryRun(current, value));
			if (value.id === runRef.current?.id)
				setRun((current) => current?.id === value.id && current.updatedAt <= value.updatedAt ? value : current);
		};
		const ready = () => {
			if (disposed || sessionScopeRef.current !== scope) return;
			void deploymentApi.history(sessionId).then((page) => {
				if (!disposed && sessionScopeRef.current === scope) {
					setHistoryState((current) => applyDeploymentHistoryPage(current, page));
				}
			}).catch((failure) => { if (!disposed && sessionScopeRef.current === scope) setError(message(failure)); });
			const current = runRef.current;
			if (current?.status === "running" || current?.status === "preparing")
				void deploymentApi.get(sessionId, current.id).then((value) => {
					if (!disposed && sessionScopeRef.current === scope)
						setRun((latest) => latest?.id === value.id && latest.updatedAt <= value.updatedAt ? value : latest);
				}).catch((failure) => { if (!disposed && sessionScopeRef.current === scope) setError(message(failure)); });
		};
		stream.addEventListener("deployment.updated", updated);
		stream.addEventListener("stream.ready", ready);
		return () => { disposed = true; stream.close(); };
	}, [locale, sessionId, workspaceId]);

	const act = useCallback(async (operation: () => Promise<DeploymentRun>) => {
		const scope = sessionScopeRef.current;
		setBusy(true);
		setError(null);
		try { const value = await operation(); if (sessionScopeRef.current === scope) applyRun(value); return value; }
		catch (failure) { if (sessionScopeRef.current === scope) setError(message(failure)); return null; }
		finally { if (sessionScopeRef.current === scope) setBusy(false); }
	}, [applyRun]);

	const show = useCallback(async () => {
		const scope = sessionScopeRef.current;
		const selectionVersion = ++selectionVersionRef.current;
		setPanelMode("current");
		setLoading(true);
		setError(null);
		try {
			const value = await refresh();
			if (sessionScopeRef.current === scope && selectionVersionRef.current === selectionVersion)
				setRun((current) => value.latest && current?.id === value.latest.id && current.updatedAt > value.latest.updatedAt ? current : value.latest);
		} catch (failure) { if (sessionScopeRef.current === scope) setError(message(failure)); }
		finally { if (sessionScopeRef.current === scope) setLoading(false); }
	}, [refresh]);

	const openHistory = useCallback(async (id: string) => {
		const selected = historyState.runs.find((candidate) => candidate.id === id);
		if (!selected) return;
		const scope = sessionScopeRef.current;
		const selectionVersion = ++selectionVersionRef.current;
		setRun(selected);
		setPanelMode("history");
		setError(null);
		try {
			const latest = await deploymentApi.get(sessionId, id);
			if (sessionScopeRef.current === scope) {
				setHistoryState((current) => addDeploymentHistoryRun(current, latest));
				if (selectionVersionRef.current === selectionVersion)
					setRun((current) => current?.id === id && current.updatedAt <= latest.updatedAt ? latest : current);
			}
		} catch (failure) {
			if (sessionScopeRef.current === scope && selectionVersionRef.current === selectionVersion) setError(message(failure));
		}
	}, [historyState.runs, sessionId]);

	const loadOlderHistory = useCallback(async (): Promise<boolean> => {
		const scope = sessionScopeRef.current;
		const cursor = historyState.nextCursor;
		if (!cursor || olderHistoryRequestRef.current?.sessionId === sessionId) return false;
		const request = { sessionId, cursor };
		olderHistoryRequestRef.current = request;
		setLoadingOlderHistory(true);
		setError(null);
		try {
			const page = await deploymentApi.history(sessionId, cursor);
			if (sessionScopeRef.current !== scope) return false;
			setHistoryState((current) => applyDeploymentHistoryPage(current, page, cursor));
			return page.runs.length > 0;
		} catch (failure) {
			if (sessionScopeRef.current === scope) setError(message(failure));
			return false;
		} finally {
			if (olderHistoryRequestRef.current === request) olderHistoryRequestRef.current = null;
			if (sessionScopeRef.current === scope) setLoadingOlderHistory(false);
		}
	}, [historyState.nextCursor, sessionId]);

	return {
		open: panelMode !== "closed", readOnly: panelMode === "history", loading, busy, discovery, run,
		history: historyState.runs, hasOlderHistory: typeof historyState.nextCursor === "string", loadingOlderHistory, error,
		show, hide: () => { ++selectionVersionRef.current; setPanelMode("closed"); },
		openHistory,
		loadOlderHistory,
		setError,
		clearRun: () => { ++selectionVersionRef.current; setRun(null); setPanelMode("current"); },
		refresh,
		prepare: (file: string, moduleId: string) => { setPanelMode("current"); return act(() => deploymentApi.prepare(sessionId, file, moduleId)); },
		decideFullAccess: (stage: DeploymentRemoteStage, approvalId: string, approved: boolean) =>
			run ? act(() => deploymentApi.decideFullAccess(sessionId, run.id, stage, approvalId, approved)) : Promise.resolve(null),
		cancel: () => run ? act(() => deploymentApi.cancel(sessionId, run.id)) : Promise.resolve(null),
	};
}

function message(error: unknown): string { return error instanceof Error ? error.message : "Deployment request failed"; }
