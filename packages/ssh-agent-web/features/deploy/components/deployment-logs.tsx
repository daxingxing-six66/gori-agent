"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown } from "lucide-react";
import { useIntl } from "react-intl";
import type { DeploymentExecutableStage, DeploymentRun } from "../model/deployment";
import type { DeploymentLogStore } from "../runtime/deployment-log-store";

export function DeploymentLogs({ run, stage, store }: { run: DeploymentRun; stage: DeploymentExecutableStage; store: DeploymentLogStore }) {
	const intl = useIntl();
	const viewportId = useId();
	const snapshot = useCallback(() => store.snapshot(run.id, stage), [run.id, stage, store]);
	const logs = useSyncExternalStore(store.subscribe, snapshot, snapshot);
	const viewport = useRef<HTMLDivElement>(null);
	const following = useRef(true);
	const [follow, setFollow] = useState(true);
	const [collapsed, setCollapsed] = useState(false);
	const [errorFocus, setErrorFocus] = useState<{ sequence: number } | null>(null);
	const chunkElements = useRef(new Map<number, HTMLElement>());
	const view = run.stages[stage];
	const durable = view.logCursor !== undefined || view.executionId !== undefined;
	useEffect(() => { if (durable) void store.load(run.id, stage); }, [durable, run.id, stage, store, view.logCursor]);
	useLayoutEffect(() => {
		const element = viewport.current;
		if (!element || collapsed) return;
		const scroll = () => { if (following.current && element.clientHeight > 0) element.scrollTop = element.scrollHeight; };
		scroll();
		const observer = new ResizeObserver(scroll);
		observer.observe(element);
		return () => observer.disconnect();
	}, [logs.chunks, view.log, collapsed]);
	const firstError = logs.chunks.find((chunk) => containsError(chunk.text));
	const legacyError = !durable && containsError(view.log);
	useLayoutEffect(() => {
		if (!errorFocus) return;
		const target = chunkElements.current.get(errorFocus.sequence);
		const element = viewport.current;
		if (target && element) {
			const targetRect = target.getBoundingClientRect();
			const viewportRect = element.getBoundingClientRect();
			element.scrollTop += targetRect.top - viewportRect.top - Math.max(0, (element.clientHeight - targetRect.height) / 2);
			target.focus({ preventScroll: true });
		}
	}, [errorFocus]);
	const registerChunk = (sequence: number, element: HTMLElement | null) => {
		if (element) chunkElements.current.set(sequence, element);
		else chunkElements.current.delete(sequence);
	};
	const scrollLatest = () => {
		following.current = true; setFollow(true); setCollapsed(false);
		if (viewport.current && viewport.current.clientHeight > 0) viewport.current.scrollTop = viewport.current.scrollHeight;
	};
	return <section className="deploy-logs" data-collapsed={collapsed} aria-label={intl.formatMessage({ id: "deploy.task.logs" })}>
		<header className="deploy-log-toolbar"><h3><button className="deploy-log-toggle" type="button" aria-expanded={!collapsed} aria-controls={viewportId}
			onClick={() => setCollapsed((value) => !value)}><ChevronDown size={13} aria-hidden="true" />{intl.formatMessage({ id: "deploy.task.logs" })}</button></h3><div>
			<button type="button" aria-pressed={follow} onClick={scrollLatest}>{intl.formatMessage({ id: "deploy.task.follow" })}</button>
			<button type="button" disabled={!firstError && !legacyError} onClick={() => {
				if (!firstError && !legacyError) return;
				following.current = false; setFollow(false);
				setCollapsed(false);
				setErrorFocus({ sequence: firstError?.sequence ?? 0 });
			}}>{intl.formatMessage({ id: "deploy.task.error" })}</button>
		</div></header>
		<div id={viewportId} hidden={collapsed} className="deploy-log-viewport app-scrollbar" ref={viewport} tabIndex={0} onScroll={() => {
			const element = viewport.current;
			if (!element || element.clientHeight === 0) return;
			const next = element.scrollHeight - element.clientHeight - element.scrollTop < 40;
			following.current = next; setFollow(next);
		}}>
			{logs.error ? <p role="alert" className="deploy-log-error">{logs.error} <button type="button" onClick={() => void store.load(run.id, stage)}>{intl.formatMessage({ id: "deploy.task.retry" })}</button></p> : null}
			{logs.chunks.length > 0 ? <pre className="deploy-log-content">{logs.chunks.map((chunk) => <span key={chunk.sequence} tabIndex={-1}
				ref={(element) => registerChunk(chunk.sequence, element)} data-log-error={containsError(chunk.text)}
				className={`deploy-log-chunk deploy-log-${chunk.kind}`} title={intl.formatTime(chunk.timestamp, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}>{chunk.text}</span>)}</pre> : null}
			{!durable && view.log ? <><p className="deploy-log-note">{intl.formatMessage({ id: "deploy.task.legacyTail" })}</p>
				<pre className="deploy-log-content" tabIndex={-1} ref={(element) => registerChunk(0, element)} data-log-error={legacyError}>{view.log}</pre></> : null}
			{logs.chunks.length === 0 && (durable || !view.log) ? <p className="deploy-log-note" role="status">{intl.formatMessage({ id: logs.loading ? "deploy.loading" : "deploy.task.noLogs" })}</p> : null}
		</div>
	</section>;
}

function containsError(text: string): boolean { return /\b(error|failed)\b|失败/iu.test(text); }
