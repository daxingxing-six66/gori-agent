"use client";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import type { DiagnoseCacheEntry } from "../runtime/use-diagnose-tasks";
import type { useDiagnoseView } from "../runtime/use-diagnose-view";
import { DiagnoseStatusBadge } from "./diagnose-status-badge";
import { DiagnoseRecordList } from "./diagnose-record-list";
import { DiagnoseConclusionPage } from "./diagnose-conclusion-page";
import { DiagnoseCopyRecords } from "./diagnose-copy-records";
import "./diagnose-task.css";

export function DiagnoseTaskPage({ sessionId, taskId, entry, busy, error, view, visible = true, onConclude, onCancel, onRetry, onOlder }: {
	sessionId: string; taskId: string; entry?: DiagnoseCacheEntry; busy: boolean; error: string | null; view: ReturnType<typeof useDiagnoseView>;
	visible?: boolean;
	onConclude(): void; onCancel(): void; onRetry(): void; onOlder(): Promise<boolean>;
}) {
	const intl = useIntl();
	const scroll = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	const pendingAnchor = useRef<{ height: number; top: number } | null>(null);
	const [hasNew, setHasNew] = useState(false);
	const [olderLoading, setOlderLoading] = useState(false);
	const saved = view.get(taskId);
	const page = saved.page;
	const nodes = entry?.nodes ?? [];
	const task = entry?.task;
	const restoreConclusion = useCallback(() => { if (scroll.current && visible && page === "conclusion") scroll.current.scrollTop = view.get(taskId).conclusionScroll; }, [visible, page, taskId, view.get]);
	useLayoutEffect(() => {
		const container = scroll.current; if (!container || !visible) return;
		container.scrollTop = page === "records" ? saved.recordsScroll : saved.conclusionScroll;
		follow.current = container.scrollHeight - container.clientHeight - container.scrollTop < 64;
	}, [taskId, page, visible]); // Each view owns its own position; data updates are handled below.
	useLayoutEffect(() => {
		const container = scroll.current; if (!container || !visible || page !== "records") return;
		const currentSequence = task?.currentSequence ?? 0;
		const latest = view.get(taskId);
		if (currentSequence > latest.seenSequence) {
			const expanded = { ...latest.expanded };
			if (latest.seenSequence && expanded[latest.seenSequence] === undefined) expanded[latest.seenSequence] = true;
			// Initial historical records stay collapsed. New records become independently expanded.
			if (latest.seenSequence) expanded[currentSequence] = true;
			view.update(taskId, { expanded, seenSequence: currentSequence });
		}
		if (pendingAnchor.current) {
			container.scrollTop = pendingAnchor.current.top + container.scrollHeight - pendingAnchor.current.height;
			pendingAnchor.current = null;
		} else if (follow.current) container.scrollTop = container.scrollHeight;
		else setHasNew(true);
	}, [nodes, task?.currentSequence, taskId, page, visible]);
	const changePage = (next: "records" | "conclusion") => {
		if (scroll.current) view.update(taskId, { [page === "records" ? "recordsScroll" : "conclusionScroll"]: scroll.current.scrollTop }, false);
		view.update(taskId, { page: next });
	};
	const loadOlder = async () => {
		if (olderLoading || !scroll.current) return;
		pendingAnchor.current = { height: scroll.current.scrollHeight, top: scroll.current.scrollTop }; setOlderLoading(true);
		try { if (!await onOlder()) pendingAnchor.current = null; } finally { setOlderLoading(false); }
	};
	return <div className="diagnose-task">
		<header className="diagnose-header"><div><span className="diagnose-eyebrow">Diagnose</span><h2>{task?.title ?? intl.formatMessage({ id: "diagnose.title" })}</h2></div>{task ? <DiagnoseStatusBadge status={task.status} /> : null}</header>
		{error ? <div className="diagnose-error" role="alert">{error}<button type="button" onClick={onRetry}>{intl.formatMessage({ id: "diagnose.retry" })}</button></div> : null}
		<div ref={scroll} className="diagnose-scroll app-scrollbar" onScroll={() => {
			const container = scroll.current; if (!container) return;
			view.update(taskId, { [page === "records" ? "recordsScroll" : "conclusionScroll"]: container.scrollTop }, false);
			follow.current = container.scrollHeight - container.clientHeight - container.scrollTop < 64;
			if (follow.current) setHasNew(false);
		}}>
			<div hidden={page !== "records"}>
				{!entry?.loaded ? <p role="status" className="diagnose-empty">{intl.formatMessage({ id: "diagnose.loading" })}</p> : null}
				{entry?.nextBeforeSequence ? <button type="button" className="diagnose-older" disabled={olderLoading} onClick={() => { void loadOlder(); }}>{intl.formatMessage({ id: "diagnose.older" })}</button> : null}
				<DiagnoseRecordList nodes={nodes} currentSequence={task?.currentSequence ?? 0} expanded={saved.expanded} onToggle={(sequence) => view.update(taskId, { expanded: { ...saved.expanded, [sequence]: !(saved.expanded[sequence] ?? sequence === task?.currentSequence) } })} />
			</div>
			{task?.conclusionAvailable ? <div hidden={page !== "conclusion"}>{page === "conclusion" ? <DiagnoseConclusionPage key={`${sessionId}:${taskId}`} sessionId={sessionId} taskId={taskId} onContentReady={restoreConclusion} /> : null}</div> : null}
		</div>
		{page === "records" && hasNew ? <button type="button" className="diagnose-return" onClick={() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; follow.current = true; setHasNew(false); }}>{intl.formatMessage({ id: "diagnose.latest" })}</button> : null}
		<footer className="diagnose-actions">
			{page === "conclusion" ? <button type="button" onClick={() => changePage("records")}>{intl.formatMessage({ id: "diagnose.back" })}</button>
				: task?.conclusionAvailable ? <button type="button" className="diagnose-primary" onClick={() => changePage("conclusion")}>{intl.formatMessage({ id: "diagnose.conclusion" })}</button>
				: task?.status === "active" ? <><button type="button" className="diagnose-primary" disabled={busy} onClick={onConclude}>{intl.formatMessage({ id: "diagnose.finish" })}</button><button type="button" onClick={onCancel}>{intl.formatMessage({ id: "diagnose.cancel" })}</button></> : null}
			{page === "records" && task && entry?.loaded ? <DiagnoseCopyRecords key={`${sessionId}:${taskId}`} sessionId={sessionId} taskId={taskId} /> : null}
		</footer>
		{task?.status === "active" && task.conclusionRequest ? <p className="diagnose-request-note" role="status">{intl.formatMessage({ id: "diagnose.summarizing" })}</p> : null}
	</div>;
}
