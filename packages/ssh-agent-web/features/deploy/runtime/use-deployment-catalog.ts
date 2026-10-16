"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deploymentApi } from "../api/deployment-api";
import type { DeploymentDiscovery, DeploymentRun } from "../model/deployment";
import { mergeDeploymentHistory } from "../model/deployment-history";

interface Catalog { discovery: DeploymentDiscovery | null; runs: DeploymentRun[]; error: string | null }
const empty = (): Catalog => ({ discovery: null, runs: [], error: null });

/** Profile discovery and cached Run facts; neither selects a page nor enters deployment mode. */
export function useDeploymentCatalog(sessionId: string) {
	const scope = useMemo(() => ({ sessionId }), [sessionId]);
	const live = useRef<typeof scope | null>(scope);
	live.current = scope;
	const [state, setState] = useState({ scope, catalog: empty() });
	const refreshVersion = useRef(0);
	const update = useCallback((change: (value: Catalog) => Catalog) => {
		if (live.current === scope) setState((current) => ({ scope, catalog: change(current.scope === scope ? current.catalog : empty()) }));
	}, [scope]);
	const upsert = useCallback((run: DeploymentRun) => {
		if (run.sessionId === sessionId) update((current) => ({ ...current, runs: mergeDeploymentHistory(current.runs, [run]) }));
	}, [sessionId, update]);
	const refresh = useCallback(async () => {
		const version = ++refreshVersion.current;
		try {
			const discovery = await deploymentApi.discover(sessionId);
			if (live.current !== scope) return null;
			if (version === refreshVersion.current) update((current) => ({ ...current, discovery, error: null }));
			if (discovery.latest) upsert(discovery.latest);
			return discovery;
		} catch (failure) {
			if (version === refreshVersion.current) update((current) => ({ ...current, error: message(failure) }));
			throw failure;
		}
	}, [scope, sessionId, update, upsert]);
	const catalog = state.scope === scope ? state.catalog : empty();

	useEffect(() => {
		live.current = scope;
		void refresh().catch(() => undefined);
		return () => { if (live.current === scope) live.current = null; };
	}, [refresh, scope]);
	return { ...catalog, refresh, upsert };
}

function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
