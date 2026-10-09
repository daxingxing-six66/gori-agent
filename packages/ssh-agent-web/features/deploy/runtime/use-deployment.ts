"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/features/i18n/components/locale-context";
import { apiUrlWithLocale } from "@/shared/api/client";
import { deploymentApi } from "../api/deployment-api";
import { isDeploymentDiscussion, isDeploymentRun, type DeploymentDiscussion, type DeploymentDiscovery, type DeploymentRemoteStage, type DeploymentRun } from "../model/deployment";
import { addDeploymentHistoryRun, applyDeploymentHistoryPage, emptyDeploymentHistory } from "../model/deployment-history";

type PanelMode = "closed" | "current" | "history";

interface DeploymentSelection {
	mode: PanelMode;
	run: DeploymentRun | null;
	freshOpenRevision: number;
}

const initialSelection: DeploymentSelection = { mode: "closed", run: null, freshOpenRevision: 0 };

export function openFreshDeployment(selection: DeploymentSelection): DeploymentSelection {
	return { mode: "current", run: null, freshOpenRevision: selection.freshOpenRevision + 1 };
}

export function refreshSelectedDeployment(selection: DeploymentSelection, latest: DeploymentRun | null, pageRuns: DeploymentRun[]): DeploymentSelection {
	const selected = selection.run;
	if (!selected) return selection;
	const pageMatch = pageRuns.find((candidate) => candidate.id === selected.id);
	const latestMatch = latest?.id === selected.id ? latest : null;
	const fresh = latestMatch && (!pageMatch || latestMatch.updatedAt > pageMatch.updatedAt) ? latestMatch : pageMatch;
	return fresh && fresh.updatedAt >= selected.updatedAt ? { ...selection, run: fresh } : selection;
}

export function useDeployment(sessionId: string, workspaceId: string | undefined) {
	const { locale } = useLocale();
	const [selection, setSelection] = useState<DeploymentSelection>(initialSelection);
	const { mode: panelMode, run } = selection;
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [discovery, setDiscovery] = useState<DeploymentDiscovery | null>(null);
	const [activeDiscussion, setActiveDiscussion] = useState<DeploymentDiscussion | null>(null);
	const [selectedDiscussion, setSelectedDiscussion] = useState<DeploymentDiscussion | null>(null);
	const [historyState, setHistoryState] = useState(emptyDeploymentHistory);
	const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const sessionScopeRef = useRef<{ sessionId: string } | null>(null);
	const selectionVersionRef = useRef(0);
	const initialSelectionVersionRef = useRef(0);
	const discussionVersionRef = useRef(0);
	const runRef = useRef<DeploymentRun | null>(null);
	const activeDiscussionRef = useRef<DeploymentDiscussion | null>(null);
	const selectedDiscussionRef = useRef<DeploymentDiscussion | null>(null);
	const beginDiscussionRequestRef = useRef<symbol | null>(null);
	const olderHistoryRequestRef = useRef<{ sessionId: string; cursor: string } | null>(null);
	useEffect(() => { runRef.current = run; }, [run]);
	const refresh = useCallback(async () => {
		const scope = sessionScopeRef.current;
		const selectionVersion = selectionVersionRef.current;
		const discussionVersion = discussionVersionRef.current;
		const [value, result] = await Promise.all([deploymentApi.discover(sessionId), deploymentApi.history(sessionId).then(
			(page) => ({ page, error: null }),
			(failure: unknown) => ({ page: null, error: message(failure) }),
		)]);
		if (sessionScopeRef.current !== scope) return value;
		const page = result.page;
		if (page) setHistoryState((current) => applyDeploymentHistoryPage(current, page));
		if (selectionVersionRef.current === selectionVersion) {
			setDiscovery(value);
			if (result.error) setError(result.error);
			// Discovery's latest run is for page recovery, not a fresh /deploy selection.
			setSelection((current) => {
				const refreshed = refreshSelectedDeployment(current, value.latest, page?.runs ?? []);
				const selectedDiscussion = selectedDiscussionRef.current;
				const proposal = selectedDiscussion ? [value.latest, ...(page?.runs ?? [])].find((candidate) =>
					candidate && (candidate.id === selectedDiscussion.deploymentRunId || candidate.discussionId === selectedDiscussion.id)) : null;
				return refreshed.mode === "current" && !refreshed.run && proposal ? { ...refreshed, run: proposal } : refreshed;
			});
			if (discussionVersionRef.current === discussionVersion) {
				activeDiscussionRef.current = value.activeDiscussion;
				setActiveDiscussion(value.activeDiscussion);
				const selectedDiscussion = selectedDiscussionRef.current;
				const currentDiscussion = value.activeDiscussion;
				if (selectedDiscussion && currentDiscussion && selectedDiscussion.id === currentDiscussion.id && currentDiscussion.updatedAt >= selectedDiscussion.updatedAt) {
					selectedDiscussionRef.current = currentDiscussion;
					setSelectedDiscussion(currentDiscussion);
				}
			}
			const selectedDiscussion = selectedDiscussionRef.current;
			if (selectedDiscussion && value.activeDiscussion?.id !== selectedDiscussion.id && !runRef.current) {
				const latestDiscussion = await deploymentApi.getDiscussion(sessionId, selectedDiscussion.id);
				if (sessionScopeRef.current !== scope || selectionVersionRef.current !== selectionVersion ||
					discussionVersionRef.current !== discussionVersion ||
					selectedDiscussionRef.current?.id !== latestDiscussion.id ||
					selectedDiscussionRef.current.revision > latestDiscussion.revision) return value;
				++discussionVersionRef.current;
				if (latestDiscussion.status === "cancelled") {
					selectedDiscussionRef.current = null;
					setSelectedDiscussion(null);
				} else {
					selectedDiscussionRef.current = latestDiscussion;
					setSelectedDiscussion(latestDiscussion);
					if (latestDiscussion.deploymentRunId) {
						const proposed = await deploymentApi.get(sessionId, latestDiscussion.deploymentRunId);
						if (sessionScopeRef.current === scope && selectionVersionRef.current === selectionVersion &&
							selectedDiscussionRef.current?.id === latestDiscussion.id) {
							setError(null);
							setHistoryState((current) => addDeploymentHistoryRun(current, proposed));
							setSelection((current) => current.mode === "current" && !current.run ? { ...current, run: proposed } : current);
						}
					}
				}
			}
		}
		return value;
	}, [sessionId]);

	useEffect(() => {
		let disposed = false;
		const scope = { sessionId };
		sessionScopeRef.current = scope;
		++discussionVersionRef.current;
		selectedDiscussionRef.current = null;
		activeDiscussionRef.current = null;
		beginDiscussionRequestRef.current = null;
		setSelectedDiscussion(null);
		setActiveDiscussion(null);
		const selectionVersion = ++selectionVersionRef.current;
		initialSelectionVersionRef.current = selectionVersion;
		setSelection(initialSelection);
		setHistoryState(emptyDeploymentHistory());
		setLoadingOlderHistory(false);
		olderHistoryRequestRef.current = null;
		setDiscovery(null);
		setError(null);
		setBusy(false);
		setLoading(false);
		const initialDiscussionVersion = discussionVersionRef.current;
		void deploymentApi.discover(sessionId).then((value) => {
			if (disposed) return;
			if (selectionVersionRef.current !== selectionVersion) return;
			setDiscovery(value);
			if (discussionVersionRef.current === initialDiscussionVersion) {
				activeDiscussionRef.current = value.activeDiscussion;
				setActiveDiscussion(value.activeDiscussion);
			}
			const latest = value.latest;
			if (value.activeDiscussion && discussionVersionRef.current === initialDiscussionVersion && selectionVersionRef.current === selectionVersion) {
				selectedDiscussionRef.current = value.activeDiscussion;
				setSelectedDiscussion(value.activeDiscussion);
				setSelection((current) => ({ ...current, run: null, mode: "current" }));
			} else if (latest && selectionVersionRef.current === selectionVersion) {
				setSelection((current) => ({ ...current,
					run: current.run && current.run.id === latest.id && current.run.updatedAt > latest.updatedAt ? current.run : latest,
					mode: latest.status === "preparing" || latest.status === "running" || latest.status === "recovering" ? "current" : current.mode,
				}));
			}
		}).catch((failure) => { if (!disposed && selectionVersionRef.current === selectionVersion) setError(message(failure)); });
		void deploymentApi.history(sessionId).then((page) => {
			if (!disposed) {
				setHistoryState((current) => applyDeploymentHistoryPage(current, page));
			}
		}).catch((failure) => { if (!disposed && selectionVersionRef.current === selectionVersion) setError(message(failure)); });
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
			setSelection((current) => {
				if (current.run?.id === value.id) return current.run.updatedAt <= value.updatedAt ? { ...current, run: value } : current;
				return current.mode === "current" && !current.run && selectedDiscussionRef.current &&
					(selectedDiscussionRef.current.deploymentRunId === value.id || selectedDiscussionRef.current.id === value.discussionId)
					? { ...current, run: value } : current;
			});
		};
		const discussionUpdated = (event: Event) => {
			if (disposed || sessionScopeRef.current !== scope || !(event instanceof MessageEvent) || typeof event.data !== "string") return;
			let value: unknown;
			try { value = JSON.parse(event.data); } catch { return; }
			if (!isDeploymentDiscussion(value) || value.sessionId !== sessionId || value.workspaceId !== workspaceId) return;
			const discussionVersion = ++discussionVersionRef.current;
			const currentActive = activeDiscussionRef.current;
			if (value.status === "discussing" && currentActive?.id === value.id) {
				if (value.revision >= currentActive.revision) {
					activeDiscussionRef.current = value;
					setActiveDiscussion(value);
				}
			} else if (value.status === "discussing") {
				// A delayed event from another tab must not choose the active discussion by timestamp.
				void deploymentApi.activeDiscussion(sessionId).then((authoritative) => {
					if (disposed || sessionScopeRef.current !== scope || discussionVersionRef.current !== discussionVersion) return;
					activeDiscussionRef.current = authoritative;
					setActiveDiscussion(authoritative);
					if (authoritative && !selectedDiscussionRef.current &&
						selectionVersionRef.current === initialSelectionVersionRef.current) {
						selectedDiscussionRef.current = authoritative;
						setSelectedDiscussion(authoritative);
						setSelection((current) => current.mode === "closed" ? { ...current, mode: "current", run: null } : current);
					}
				}).catch((failure) => { if (!disposed && sessionScopeRef.current === scope) setError(message(failure)); });
			} else if (currentActive?.id === value.id) {
				activeDiscussionRef.current = null;
				setActiveDiscussion(null);
			}
			if (selectedDiscussionRef.current?.id !== value.id || value.updatedAt < selectedDiscussionRef.current.updatedAt) return;
			if (value.status === "cancelled") {
				selectedDiscussionRef.current = null;
				setSelectedDiscussion(null);
				return;
			}
			selectedDiscussionRef.current = value;
			setSelectedDiscussion(value);
			if (!value.deploymentRunId) return;
			const selectionVersion = selectionVersionRef.current;
			void deploymentApi.get(sessionId, value.deploymentRunId).then((proposal) => {
				if (disposed || sessionScopeRef.current !== scope || selectionVersionRef.current !== selectionVersion) return;
				setError(null);
				setHistoryState((current) => addDeploymentHistoryRun(current, proposal));
				setSelection((current) => current.mode === "current" && !current.run && selectedDiscussionRef.current?.id === value.id
					? { ...current, run: proposal } : current);
			}).catch((failure) => { if (!disposed && sessionScopeRef.current === scope) setError(message(failure)); });
		};
		const ready = () => {
			if (disposed || sessionScopeRef.current !== scope) return;
			void refresh().catch((failure) => { if (!disposed && sessionScopeRef.current === scope) setError(message(failure)); });
			const current = runRef.current;
			if (current?.status === "running" || current?.status === "preparing" || current?.status === "recovering")
				void deploymentApi.get(sessionId, current.id).then((value) => {
					if (!disposed && sessionScopeRef.current === scope)
						setSelection((latest) => latest.run?.id === value.id && latest.run.updatedAt <= value.updatedAt ? { ...latest, run: value } : latest);
				}).catch((failure) => { if (!disposed && sessionScopeRef.current === scope) setError(message(failure)); });
		};
		stream.addEventListener("deployment.updated", updated);
		stream.addEventListener("deployment.discussion.updated", discussionUpdated);
		stream.addEventListener("stream.ready", ready);
		return () => { disposed = true; stream.close(); };
	}, [locale, refresh, sessionId, workspaceId]);

	const act = useCallback(async (operation: () => Promise<DeploymentRun>) => {
		const scope = sessionScopeRef.current;
		const selectionVersion = selectionVersionRef.current;
		setBusy(true);
		setError(null);
		try {
			const value = await operation();
			if (sessionScopeRef.current === scope) {
				setHistoryState((current) => addDeploymentHistoryRun(current, value));
				if (selectionVersionRef.current === selectionVersion)
					setSelection((current) => current.run?.id === value.id && current.run.updatedAt > value.updatedAt
						? current : { ...current, run: value });
			}
			return value;
		} catch (failure) {
			if (sessionScopeRef.current === scope && selectionVersionRef.current === selectionVersion) setError(message(failure));
			return null;
		}
		finally { if (sessionScopeRef.current === scope) setBusy(false); }
	}, []);

	const show = useCallback(async () => {
		const scope = sessionScopeRef.current;
		const selectionVersion = ++selectionVersionRef.current;
		selectedDiscussionRef.current = null;
		setSelectedDiscussion(null);
		setSelection(openFreshDeployment);
		setDiscovery(null);
		setLoading(true);
		setError(null);
		try {
			await refresh();
		} catch (failure) { if (sessionScopeRef.current === scope && selectionVersionRef.current === selectionVersion) setError(message(failure)); }
		finally {
			if (sessionScopeRef.current === scope && selectionVersionRef.current === selectionVersion) setLoading(false);
		}
	}, [refresh]);

	const openHistory = useCallback(async (id: string) => {
		const selected = historyState.runs.find((candidate) => candidate.id === id);
		if (!selected) return;
		const scope = sessionScopeRef.current;
		const selectionVersion = ++selectionVersionRef.current;
		selectedDiscussionRef.current = null;
		setSelectedDiscussion(null);
		setSelection((current) => ({ ...current, run: selected, mode: selected.status === "recovering" ? "current" : "history" }));
		setLoading(false);
		setError(null);
		try {
			const latest = await deploymentApi.get(sessionId, id);
			if (sessionScopeRef.current === scope) {
				setHistoryState((current) => addDeploymentHistoryRun(current, latest));
				if (selectionVersionRef.current === selectionVersion)
					setSelection((current) => current.run?.id === id && current.run.updatedAt <= latest.updatedAt ? { ...current, run: latest } : current);
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

	const beginDiscussion = useCallback(async (file: string, moduleId: string): Promise<DeploymentDiscussion | null> => {
		const scope = sessionScopeRef.current;
		const selectionVersion = ++selectionVersionRef.current;
		const discussionVersion = discussionVersionRef.current;
		const request = Symbol("begin deployment discussion");
		beginDiscussionRequestRef.current = request;
		setBusy(true);
		setError(null);
		try {
			const value = await deploymentApi.beginDiscussion(sessionId, file, moduleId);
			if (sessionScopeRef.current !== scope || selectionVersionRef.current !== selectionVersion) return null;
			if (discussionVersionRef.current !== discussionVersion && activeDiscussionRef.current?.id !== value.id) {
				const lookupVersion = discussionVersionRef.current;
				const authoritative = await deploymentApi.activeDiscussion(sessionId);
				if (sessionScopeRef.current !== scope || selectionVersionRef.current !== selectionVersion ||
					discussionVersionRef.current !== lookupVersion) return null;
				activeDiscussionRef.current = authoritative;
				setActiveDiscussion(authoritative);
				if (authoritative?.id !== value.id) {
					selectedDiscussionRef.current = authoritative;
					setSelectedDiscussion(authoritative);
					return null;
				}
			}
			++discussionVersionRef.current;
			activeDiscussionRef.current = value;
			setActiveDiscussion(value);
			selectedDiscussionRef.current = value;
			setSelectedDiscussion(value);
			setSelection((current) => ({ ...current, mode: "current", run: null }));
			return value;
		} catch (failure) {
			if (sessionScopeRef.current === scope && selectionVersionRef.current === selectionVersion) setError(message(failure));
			return null;
		} finally {
			if (sessionScopeRef.current === scope && beginDiscussionRequestRef.current === request) {
				beginDiscussionRequestRef.current = null;
				setBusy(false);
			}
		}
	}, [sessionId]);

	const cancelDiscussion = useCallback(async (): Promise<void> => {
		const selected = selectedDiscussionRef.current;
		if (!selected || selected.status !== "discussing") return;
		const scope = sessionScopeRef.current;
		const selectionVersion = selectionVersionRef.current;
		setBusy(true);
		setError(null);
		try {
			await deploymentApi.cancelDiscussion(sessionId, selected.id);
			if (sessionScopeRef.current !== scope) return;
			++discussionVersionRef.current;
			if (activeDiscussionRef.current?.id === selected.id) {
				activeDiscussionRef.current = null;
				setActiveDiscussion(null);
			}
			if (selectionVersionRef.current === selectionVersion && selectedDiscussionRef.current?.id === selected.id) {
				selectedDiscussionRef.current = null;
				setSelectedDiscussion(null);
			}
		} catch (failure) {
			if (sessionScopeRef.current === scope && selectionVersionRef.current === selectionVersion) setError(message(failure));
		} finally { if (sessionScopeRef.current === scope) setBusy(false); }
	}, [sessionId]);

	return {
		open: panelMode !== "closed", readOnly: panelMode === "history", loading, busy, discovery, run, activeDiscussion, selectedDiscussion,
		freshOpenRevision: selection.freshOpenRevision,
		history: historyState.runs, hasOlderHistory: typeof historyState.nextCursor === "string", loadingOlderHistory, error,
		show, hide: () => { ++selectionVersionRef.current; selectedDiscussionRef.current = null; setSelectedDiscussion(null); setSelection((current) => ({ ...current, mode: "closed" })); setLoading(false); },
		openHistory,
		loadOlderHistory,
		setError,
		clearRun: () => { ++selectionVersionRef.current; selectedDiscussionRef.current = null; setSelectedDiscussion(null); setSelection((current) => ({ ...current, run: null, mode: "current" })); },
		refresh,
		beginDiscussion, cancelDiscussion,
		decideFullAccess: (stage: DeploymentRemoteStage, approvalId: string, approved: boolean) =>
			run ? act(() => deploymentApi.decideFullAccess(sessionId, run.id, stage, approvalId, approved)) : Promise.resolve(null),
		decideRecovery: (proposalId: string, approved: boolean) =>
			run ? act(() => deploymentApi.decideRecovery(sessionId, run.id, proposalId, approved)) : Promise.resolve(null),
		cancel: () => run ? act(() => deploymentApi.cancel(sessionId, run.id)) : Promise.resolve(null),
	};
}

function message(error: unknown): string { return error instanceof Error ? error.message : "Deployment request failed"; }
