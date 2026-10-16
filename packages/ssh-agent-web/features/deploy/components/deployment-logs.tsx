"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown } from "lucide-react";
import { useIntl } from "react-intl";
import type { DeploymentExecutableStage, DeploymentRun } from "../model/deployment";
import type { DeploymentLogChunk } from "../model/deployment-task";
import type { DeploymentLogStore } from "../runtime/deployment-log-store";

export function DeploymentLogs({ run, stage, store }: { run: DeploymentRun; stage: DeploymentExecutableStage; store: DeploymentLogStore }) {
	const intl = useIntl();
	const snapshot = useCallback(() => store.snapshot(run.id, stage), [run.id, stage, store]);
	const logs = useSyncExternalStore(store.subscribe, snapshot, snapshot);
	const viewport = useRef<HTMLDivElement>(null);
	const following = useRef(true);
	const [follow, setFollow] = useState(true);
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
	const [errorFocus, setErrorFocus] = useState<{ sequence: number } | null>(null);
	const chunkElements = useRef(new Map<number, HTMLElement>());
	const view = run.stages[stage];
	const durable = view.logCursor !== undefined || view.executionId !== undefined;
	useEffect(() => { if (durable) void store.load(run.id, stage); }, [durable, run.id, stage, store, view.logCursor]);
	useLayoutEffect(() => {
		const element = viewport.current;
		if (!element) return;
		const scroll = () => { if (following.current && element.clientHeight > 0) element.scrollTop = element.scrollHeight; };
		scroll();
		const observer = new ResizeObserver(scroll);
		observer.observe(element);
		return () => observer.disconnect();
	}, [logs.chunks, view.log]);
	const groups = useMemo(() => {
		const result: { id: string; chunks: DeploymentLogChunk[] }[] = [];
		for (const chunk of logs.chunks) {
			let group = result.at(-1);
			if (group?.id !== chunk.executionId) { group = { id: chunk.executionId, chunks: [] }; result.push(group); }
			group!.chunks.push(chunk);
		}
		return result;
	}, [logs.chunks]);
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
		following.current = true; setFollow(true);
		if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
	};
	return <section className="deploy-logs" aria-label={intl.formatMessage({ id: "deploy.task.logs" })}>
		<header className="deploy-log-toolbar"><h3>{intl.formatMessage({ id: "deploy.task.logs" })}</h3><div>
			<button type="button" aria-pressed={follow} onClick={scrollLatest}>{intl.formatMessage({ id: "deploy.task.follow" })}</button>
			<button type="button" disabled={!firstError && !legacyError} onClick={() => {
				if (!firstError && !legacyError) return;
				following.current = false; setFollow(false);
				if (firstError) setCollapsed((current) => new Set([...current].filter((id) => id !== firstError.executionId)));
				setErrorFocus({ sequence: firstError?.sequence ?? 0 });
			}}>{intl.formatMessage({ id: "deploy.task.error" })}</button>
		</div></header>
		{logs.error ? <p role="alert" className="deploy-log-error">{logs.error} <button type="button" onClick={() => void store.load(run.id, stage)}>{intl.formatMessage({ id: "deploy.task.retry" })}</button></p> : null}
		<div className="deploy-log-viewport app-scrollbar" ref={viewport} tabIndex={0} onScroll={() => {
			const element = viewport.current;
			if (!element || element.clientHeight === 0) return;
			const next = element.scrollHeight - element.clientHeight - element.scrollTop < 40;
			following.current = next; setFollow(next);
		}}>
			{groups.map((group) => <LogGroup key={group.id} chunks={group.chunks} open={!collapsed.has(group.id)} registerChunk={registerChunk}
				onToggle={() => setCollapsed((current) => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; })} />)}
			{!durable && view.log ? <><p className="deploy-log-note">{intl.formatMessage({ id: "deploy.task.legacyTail" })}</p>
				<pre tabIndex={-1} ref={(element) => registerChunk(0, element)} data-log-error={legacyError}>{view.log}</pre></> : null}
			{groups.length === 0 && !view.log ? <p className="deploy-log-note" role="status">{intl.formatMessage({ id: logs.loading ? "deploy.loading" : "deploy.task.noLogs" })}</p> : null}
		</div>
	</section>;
}

function LogGroup({ chunks, open, onToggle, registerChunk }: { chunks: DeploymentLogChunk[]; open: boolean; onToggle(): void;
	registerChunk(sequence: number, element: HTMLElement | null): void }) {
	const intl = useIntl();
	const first = chunks[0]!;
	return <div className="deploy-log-group">
		<button className="deploy-log-group-toggle" type="button" aria-expanded={open} onClick={onToggle}>
			<ChevronDown size={13} aria-hidden="true" style={{ transform: open ? undefined : "rotate(-90deg)" }} />
			<time dateTime={new Date(first.timestamp).toISOString()}>{intl.formatTime(first.timestamp, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
			<span>{intl.formatMessage({ id: `deploy.stage.${first.stage}` })}</span>
		</button>
		<div hidden={!open}>{chunks.map((chunk) => <pre key={chunk.sequence} tabIndex={-1} ref={(element) => registerChunk(chunk.sequence, element)} data-log-error={containsError(chunk.text)}
			className={`deploy-log-chunk deploy-log-${chunk.kind}`} title={intl.formatTime(chunk.timestamp, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}>{chunk.text}</pre>)}</div>
	</div>;
}

function containsError(text: string): boolean { return /\b(error|failed)\b|失败/iu.test(text); }
