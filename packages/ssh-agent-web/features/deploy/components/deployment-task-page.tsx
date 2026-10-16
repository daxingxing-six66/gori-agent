"use client";

import { Check, Circle, CircleX, LoaderCircle, Minus, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { DEPLOY_STAGES, type DeploymentDiscussion, type DeploymentDiscovery, type DeploymentRun, type DeployStage } from "../model/deployment";
import type { DeploymentTask } from "../model/deployment-task";
import type { DeploymentLogStore } from "../runtime/deployment-log-store";
import { DeploymentLogs } from "./deployment-logs";
import { DeploymentModulePicker } from "./deployment-module-picker";
import "./deployment-task.css";

export function DeploymentTaskPage({ sessionId, task, run, discussion, discovery, logs, loading, busy, error, canPlan,
	fullscreen, pending, onPlan, onSetup, onExit, onReturnConversation, onSubmit }: {
	sessionId: string; task: DeploymentTask | null; run: DeploymentRun | null; discussion: DeploymentDiscussion | null;
	discovery: DeploymentDiscovery | null; logs: DeploymentLogStore; loading: boolean; busy: boolean; error: string | null;
	canPlan: boolean; fullscreen: boolean; pending: boolean; onPlan(file: string, moduleId: string): void; onSetup(): void;
	onExit?: () => void; onReturnConversation(): void; onSubmit(message: string): Promise<boolean>;
}) {
	const intl = useIntl();
	const [selected, setSelected] = useState<{ runId: string; stage: DeployStage } | null>(null);
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const [now, setNow] = useState(Date.now);
	const scope = useMemo(() => ({ sessionId }), [sessionId]);
	const currentScope = useRef(scope);
	currentScope.current = scope;
	const sendRequest = useRef<symbol | null>(null);
	useEffect(() => { sendRequest.current = null; setDraft(""); setSelected(null); setSending(false); }, [scope]);
	useEffect(() => { if (!run || run.status !== "running") return; const timer = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(timer); }, [run?.id, run?.status]);
	const current = run ? DEPLOY_STAGES.find((stage) => run.stages[stage].status === "running")
		?? DEPLOY_STAGES.find((stage) => run.stages[stage].status === "failed")
		?? task?.stage ?? DEPLOY_STAGES.filter((stage) => run.stages[stage].status === "success" || run.stages[stage].status === "skipped").at(-1) ?? "prepare" : null;
	const stage = run && selected?.runId === run.id ? selected.stage : current;
	const status = task?.deployment.outcome ?? (run ? run.status === "preparing" ? "review" : run.status : discussion ? "discussion" : null);
	const title = task?.deployment.title ?? run?.plan.module.name ?? discussion?.module.name;
	return <section className="deploy-task-page" aria-label="Deploy">
		{error ? <p role="alert" className="deploy-task-error">{error}</p> : null}
		{loading ? <p role="status" className="deploy-task-empty">{intl.formatMessage({ id: "deploy.loading" })}</p> : null}
		{title ? <header className="deploy-task-heading"><div><h2>{title}</h2><p>{run?.plan.target.host ?? discussion?.targetBinding.hostname}</p></div>
			{status ? <span className="deploy-task-state" data-status={status}><StatusIcon status={current && run ? run.stages[current].status : "pending"} />
				{intl.formatMessage({ id: status === "review" || status === "discussion" ? `deploy.task.${status}` : `deploy.runStatus.${status}` })}</span> : null}</header> : null}
		{task?.deployment.reason ? <p className={task.deployment.outcome === "failed" ? "deploy-task-error" : "text-xs text-muted"}>{task.deployment.reason}</p> : null}
		{!run && !discussion && !task && discovery ? <div className="deploy-task-picker">
			{discovery.errors.map((problem) => <p className="deploy-task-error" key={problem.file}>{problem.file}: {problem.message}</p>)}
			{discovery.profiles.length > 0 ? <DeploymentModulePicker profiles={discovery.profiles} busy={busy} disabled={!canPlan} onSelect={onPlan} /> : <p className="text-sm text-muted">{intl.formatMessage({ id: "deploy.noProfile" })}</p>}
			<button type="button" className="deploy-task-button" disabled={busy || !canPlan} onClick={onSetup}>{intl.formatMessage({ id: "deploy.task.addService" })}</button>
		</div> : null}
		{run ? <>
			<ol className="deploy-stage-overview" aria-label={intl.formatMessage({ id: "deploy.pipeline" })}>
				{DEPLOY_STAGES.map((name) => <li key={name} data-status={run.stages[name].status} data-current={name === current} data-selected={name === stage}>
					<button type="button" aria-pressed={name === stage} aria-current={name === current ? "step" : undefined} onClick={() => setSelected({ runId: run.id, stage: name })}>
						<StatusIcon status={run.stages[name].status} /><span>{intl.formatMessage({ id: `deploy.stage.${name}` })}</span>
					</button></li>)}
			</ol>
			{stage ? <div className="deploy-stage-facts"><div className="deploy-stage-title"><h3>{intl.formatMessage({ id: `deploy.stage.${stage}` })}</h3>
				<span>{intl.formatMessage({ id: `deploy.status.${run.stages[stage].status}` })}{run.stages[stage].startedAt ? ` · ${intl.formatMessage({ id: "deploy.task.elapsed" }, { seconds: Math.max(0, Math.floor(((run.stages[stage].finishedAt ?? now) - run.stages[stage].startedAt!) / 1000)) })}` : ""}</span></div>
				{stage === "build" && run.stages.build.step ? <div className="deploy-build-step"><span>{intl.formatMessage({ id: "deploy.task.step" }, run.stages.build.step)}</span><code>{run.stages.build.step.command}</code></div> : null}
				{stage === "upload" && run.stages.upload.artifact ? <ArtifactProgress artifact={run.stages.upload.artifact} /> : null}
				{run.stages[stage].error ? <p role="alert" className="deploy-task-error">{run.stages[stage].error}</p> : null}
			</div> : null}
			<div className="deploy-stage-logs">{DEPLOY_STAGES.slice(1).map((name) => <div key={`${run.id}:${name}`} hidden={name !== stage} className="deploy-stage-log-page"><DeploymentLogs run={run} stage={name as Exclude<DeployStage, "prepare">} store={logs} /></div>)}</div>
		</> : null}
		<footer className="deploy-task-footer">
			{pending ? <span className="deploy-task-pending">{intl.formatMessage({ id: "deploy.task.pending" })}</span> : null}
			{task && !task.deployment.outcome || pending ? <button type="button" onClick={onReturnConversation}>{intl.formatMessage({ id: "deploy.task.return" })}</button> : null}
			{onExit ? <button type="button" disabled={busy} onClick={onExit}>{intl.formatMessage({ id: "deploy.task.exit" })}</button> : null}
		</footer>
		<form className="deploy-task-composer" hidden={!fullscreen || !task || Boolean(task.deployment.outcome)} onSubmit={async (event) => {
			event.preventDefault();
			if (!draft.trim() || sendRequest.current || currentScope.current !== scope || !fullscreen || !task || task.deployment.outcome) return;
			const request = Symbol("deployment suggestion"); sendRequest.current = request;
			const submitted = draft;
			setSending(true);
			try {
				if (await onSubmit(submitted) && currentScope.current === scope)
					setDraft((current) => current === submitted ? "" : current);
			} finally {
				if (currentScope.current === scope && sendRequest.current === request) { sendRequest.current = null; setSending(false); }
			}
		}}><textarea aria-label={intl.formatMessage({ id: "deploy.task.suggestion" })} placeholder={intl.formatMessage({ id: "deploy.task.suggestion" })} value={draft} rows={2} onChange={(event) => setDraft(event.target.value)} />
			<button type="submit" disabled={sending || !draft.trim()} aria-label={intl.formatMessage({ id: "deploy.task.send" })}><Send size={16} /></button></form>
	</section>;
}

function StatusIcon({ status }: { status: DeploymentRun["stages"][DeployStage]["status"] }) {
	const Icon = status === "success" ? Check : status === "running" ? LoaderCircle : status === "failed" ? CircleX : status === "skipped" ? Minus : Circle;
	return <Icon size={15} aria-hidden="true" className={status === "running" ? "motion-safe:animate-spin" : undefined} />;
}

function ArtifactProgress({ artifact }: { artifact: NonNullable<DeploymentRun["stages"]["upload"]["artifact"]> }) {
	const percent = artifact.totalBytes > 0 ? Math.round(artifact.bytesTransferred / artifact.totalBytes * 100) : null;
	const bytes = (value: number) => {
		if (value < 1024) return `${value} B`;
		const unit = value < 1024 ** 2 ? 1 : value < 1024 ** 3 ? 2 : 3;
		return `${(value / 1024 ** unit).toFixed(1)} ${["B", "KiB", "MiB", "GiB"][unit]}`;
	};
	return <div className="deploy-artifact"><div><strong>{artifact.source.split(/[\\/]/u).at(-1)}</strong><span>{percent === null ? "—" : `${percent}%`}</span></div>
		<p>{artifact.remotePath}</p><progress aria-label={artifact.source} value={artifact.bytesTransferred} max={artifact.totalBytes || 1} />
		<div><span>{bytes(artifact.bytesTransferred)} / {bytes(artifact.totalBytes)}</span><span>{artifact.index} / {artifact.count}</span></div></div>;
}
