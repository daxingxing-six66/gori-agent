"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deploymentApi } from "../api/deployment-api";
import type { DeploymentDiscovery, DeploymentRun } from "../model/deployment";
import { addDeploymentHistoryRun, applyDeploymentHistoryPage, emptyDeploymentHistory, type DeploymentHistoryState } from "../model/deployment-history";

interface Catalog { discovery: DeploymentDiscovery | null; history: DeploymentHistoryState; error: string | null; loadingOlder: boolean }
const empty = (): Catalog => ({ discovery: null, history: emptyDeploymentHistory(), error: null, loadingOlder: false });

/** Profile discovery and paged Run facts; neither selects a page nor enters deployment mode. */
export function useDeploymentCatalog(sessionId: string) {
	const scope = useMemo(() => ({ sessionId }), [sessionId]);
	const live = useRef<typeof scope | null>(scope);
	live.current = scope;
	const [state, setState] = useState({ scope, catalog: empty() });
	const refreshVersion = useRef(0);
	const olderRequest = useRef<Promise<boolean> | null>(null);
	const update = useCallback((change: (value: Catalog) => Catalog) => {
		if (live.current === scope) setState((current) => ({ scope, catalog: change(current.scope === scope ? current.catalog : empty()) }));
	}, [scope]);
	const upsert = useCallback((run: DeploymentRun) => {
		if (run.sessionId === sessionId) update((current) => ({ ...current, history: addDeploymentHistoryRun(current.history, run) }));
	}, [sessionId, update]);
	const refresh = useCallback(async () => {
		const version = ++refreshVersion.current;
		const [discovery, history] = await Promise.allSettled([deploymentApi.discover(sessionId), deploymentApi.history(sessionId)]);
		if (live.current !== scope) return null;
		update((current) => ({ ...current,
			discovery: version === refreshVersion.current && discovery.status === "fulfilled" ? discovery.value : current.discovery,
			history: history.status === "fulfilled" ? applyDeploymentHistoryPage(current.history, history.value) : current.history,
			error: version === refreshVersion.current ? discovery.status === "rejected" ? message(discovery.reason)
				: history.status === "rejected" ? message(history.reason) : null : current.error,
		}));
		if (discovery.status === "rejected") throw discovery.reason;
		if (discovery.value.latest) upsert(discovery.value.latest);
		return discovery.value;
	}, [scope, sessionId, update, upsert]);
	const catalog = state.scope === scope ? state.catalog : empty();
	const loadOlder = useCallback((): Promise<boolean> => {
		if (olderRequest.current) return olderRequest.current;
		const cursor = catalog.history.nextCursor;
		if (!cursor) return Promise.resolve(false);
		update((current) => ({ ...current, loadingOlder: true, error: null }));
		const task = deploymentApi.history(sessionId, cursor).then((page) => {
			if (live.current !== scope) return false;
			update((current) => ({ ...current, history: applyDeploymentHistoryPage(current.history, page, cursor) }));
			return page.runs.length > 0;
		}).catch((failure: unknown) => { update((current) => ({ ...current, error: message(failure) })); return false; })
			.finally(() => {
				if (olderRequest.current === task) olderRequest.current = null;
				update((current) => ({ ...current, loadingOlder: false }));
			});
		olderRequest.current = task;
		return task;
	}, [catalog.history.nextCursor, scope, sessionId, update]);
	useEffect(() => {
		live.current = scope;
		olderRequest.current = null;
		void refresh().catch(() => undefined);
		return () => { if (live.current === scope) live.current = null; };
	}, [refresh, scope]);
	return { ...catalog, refresh, upsert, loadOlder };
}

function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
