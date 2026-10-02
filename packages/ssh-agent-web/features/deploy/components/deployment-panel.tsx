"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Rocket, ShieldAlert, X } from "lucide-react";
import { useIntl } from "react-intl";
import type { DeploymentDiscovery, DeploymentRemoteStage, DeploymentRun, DeployStage } from "../model/deployment";
import { DEPLOY_STAGES } from "../model/deployment";

interface Props {
	discovery: DeploymentDiscovery | null;
	run: DeploymentRun | null;
	loading: boolean;
	busy: boolean;
	error: string | null;
	onClose(): void;
	onPrepare(file: string, moduleId: string): void;
	onConfirm(): void;
	onDecideFullAccess(stage: DeploymentRemoteStage, approvalId: string, approved: boolean): void;
	onCancel(): void;
	onNewPlan(): void;
	onSetup(): void;
	canSetup: boolean;
	canConfirm: boolean;
	readOnly?: boolean;
}

const REMOTE_STAGES: readonly DeploymentRemoteStage[] = ["restart", "verify"];

export function DeploymentPanel(props: Props) {
	const intl = useIntl();
	const [file, setFile] = useState("");
	const [moduleId, setModuleId] = useState("");
	const [now, setNow] = useState(() => Date.now());
	const profiles = props.discovery?.profiles ?? [];
	const selectedFile = profiles.some((profile) => profile.file === file) ? file : profiles[0]?.file ?? "";
	const profile = profiles.find((candidate) => candidate.file === selectedFile);
	const modules = useMemo(() => profile?.modules ?? [], [profile]);
	const selectedModule = modules.some((module) => module.id === moduleId) ? moduleId : modules[0]?.id ?? "";
	useEffect(() => { setModuleId(""); }, [selectedFile]);
	useEffect(() => {
		if (props.run?.status !== "preparing" || props.run.plan.remoteAccess.mode !== "full_access") return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, [props.run?.id, props.run?.status, props.run?.plan.remoteAccess.mode]);

	const run = props.run;
	const approvalStages = run?.plan.verify ? REMOTE_STAGES : REMOTE_STAGES.slice(0, 1);
	const approvalsNeeded = run?.plan.remoteAccess.mode === "full_access"
		? approvalStages.filter((stage) => {
			const approval = run.fullAccessApprovals?.[stage];
			return approval?.status !== "approved" || (approval.expiresAt ?? 0) <= now;
		}).length
		: 0;
	const completedStages = run
		? DEPLOY_STAGES.filter((stage) => ["success", "skipped"].includes(run.stages[stage].status)).length
		: 0;
	const stageErrors = run ? new Set(DEPLOY_STAGES.map((stage) => run.stages[stage].error)) : new Set<string | undefined>();

	return <section role="region" aria-label={intl.formatMessage({ id: "deploy.title" })} className="rounded-[22px] border border-line bg-surface-raised p-5 shadow-[var(--shadow-soft)] sm:p-6">
		<header className="flex min-w-0 items-start justify-between gap-3 border-b border-line-soft pb-4">
			<div className="min-w-0">
				<div className="flex flex-wrap items-center gap-2">
					<Rocket size={18} className="shrink-0 text-accent" aria-hidden="true" />
					<h2 className="text-base font-semibold text-ink">{intl.formatMessage({ id: "deploy.title" })}</h2>
					{run ? <span className={["rounded-full px-2.5 py-1 text-[11px] font-medium", runStatusTone(run.status)].join(" ")} aria-live="polite">
						{intl.formatMessage({ id: `deploy.runStatus.${run.status}` })}
					</span> : null}
				</div>
				{run ? <p className="mt-1 min-w-0 break-words text-xs text-secondary">
					<span className="font-medium text-ink">{run.plan.project}</span>
					<span className="px-1.5 text-faint">/</span>{run.plan.module.name}
					<span className="px-1.5 text-faint">→</span>{run.plan.target.host}
				</p> : null}
			</div>
			<button type="button" onClick={props.onClose} aria-label={intl.formatMessage({ id: "deploy.close" })} className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><X size={18} /></button>
		</header>

		{props.error ? <p role="alert" className="mt-4 rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-xs text-danger">{props.error}</p> : null}
		{props.loading || !props.discovery ? <p className="mt-6 text-sm text-muted">{intl.formatMessage({ id: "deploy.loading" })}</p> : null}

		{props.discovery && !run ? <div className="mt-5 space-y-5">
			<p className="text-xs text-muted">{intl.formatMessage({ id: "deploy.host" })}: <span className="font-medium text-ink">{props.discovery.host}</span></p>
			{props.discovery.errors.map(({ file: invalidFile, message }) => <p key={invalidFile} className="rounded-lg bg-[var(--warning-soft)] px-3 py-2 text-xs text-warning">{invalidFile}: {message}</p>)}
			{profiles.length === 0 ? <div className="rounded-xl border border-dashed border-line bg-surface-muted p-4">
				<p className="text-sm font-medium text-ink">{intl.formatMessage({ id: "deploy.noProfile" })}</p>
				<p className="mt-1 text-xs text-muted">{intl.formatMessage({ id: "deploy.setupHint" })}</p>
				<button type="button" disabled={props.busy || !props.canSetup} onClick={props.onSetup} className="mt-4 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-[var(--text-inverse)] hover:bg-accent-hover disabled:opacity-50">{intl.formatMessage({ id: "deploy.setup" })}</button>
				{!props.canSetup ? <p className="mt-2 text-xs text-muted">{intl.formatMessage({ id: "deploy.selectModel" })}</p> : null}
			</div> : <>
				<div className="grid gap-4 sm:grid-cols-2">
					<label className="block min-w-0 text-xs font-medium text-secondary">{intl.formatMessage({ id: "deploy.profile" })}<select value={selectedFile} onChange={(event) => setFile(event.target.value)} className="mt-1.5 block w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{profiles.map((item) => <option key={item.file} value={item.file}>{item.project} · {item.file}</option>)}</select></label>
					<label className="block min-w-0 text-xs font-medium text-secondary">{intl.formatMessage({ id: "deploy.module" })}<select value={selectedModule} onChange={(event) => setModuleId(event.target.value)} className="mt-1.5 block w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{modules.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.id})</option>)}</select></label>
				</div>
				<button type="button" disabled={!selectedFile || !selectedModule || props.busy} onClick={() => props.onPrepare(selectedFile, selectedModule)} className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-[var(--text-inverse)] hover:bg-accent-hover disabled:opacity-50">{intl.formatMessage({ id: "deploy.review" })}</button>
			</>}
		</div> : null}

		{run ? <>
			{run.plan.remoteAccess.mode === "full_access" ? <FullAccessNotice run={run} /> : null}
			<div className="mt-6 flex flex-wrap items-baseline justify-between gap-2">
				<h3 className="text-sm font-semibold text-ink">{intl.formatMessage({ id: "deploy.pipeline" })}</h3>
				<span className="text-xs tabular-nums text-muted">{intl.formatMessage({ id: "deploy.pipeline.progress" }, { completed: completedStages, total: DEPLOY_STAGES.length })}</span>
			</div>
			<ol aria-label={intl.formatMessage({ id: "deploy.pipeline" })} className="mt-5">
				{DEPLOY_STAGES.map((stage, index) => <PipelineStep key={stage} run={run} stage={stage} last={index === DEPLOY_STAGES.length - 1}
					now={now} busy={props.busy} readOnly={props.readOnly === true} onDecideFullAccess={props.onDecideFullAccess} />)}
			</ol>
			{run.error && !stageErrors.has(run.error) ? <p role="alert" className="mt-4 rounded-lg bg-[var(--danger-soft)] p-3 text-xs text-danger">{run.error}</p> : null}
			{!props.readOnly ? <footer className="mt-5 flex flex-wrap items-center gap-3 border-t border-line-soft pt-4">
				{run.status === "preparing" ? <button type="button" disabled={props.busy || approvalsNeeded > 0 || !props.canConfirm} onClick={props.onConfirm} className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-[var(--text-inverse)] hover:bg-accent-hover disabled:opacity-50">{intl.formatMessage({ id: "deploy.confirm" })}</button> : null}
				{run.status === "preparing" && approvalsNeeded > 0 ? <span className="text-xs text-warning" aria-live="polite">{intl.formatMessage({ id: "deploy.fullAccess.waiting" }, { count: approvalsNeeded })}</span> : null}
				{run.status === "preparing" && !props.canConfirm ? <span className="text-xs text-muted">{intl.formatMessage({ id: "deploy.selectModelExecution" })}</span> : null}
				{run.status === "preparing" || run.status === "running"
					? <button type="button" disabled={props.busy} onClick={props.onCancel} className="rounded-lg border border-line px-4 py-2 text-xs text-secondary hover:bg-surface-hover disabled:opacity-50">{intl.formatMessage({ id: "deploy.cancel" })}</button>
					: <button type="button" onClick={props.onNewPlan} className="rounded-lg border border-line px-4 py-2 text-xs text-secondary hover:bg-surface-hover">{intl.formatMessage({ id: "deploy.newPlan" })}</button>}
			</footer> : null}
		</> : null}
	</section>;
}

function FullAccessNotice({ run }: { run: DeploymentRun }) {
	const intl = useIntl();
	if (run.plan.remoteAccess.mode !== "full_access") return null;
	const identity = [run.plan.targetBinding.remoteUser, "@", run.plan.target.host, ":", run.plan.targetBinding.port].join("");
	return <div className="mt-5 rounded-xl border border-[var(--warning-line)] bg-[var(--warning-soft)] px-4 py-3 text-xs text-secondary" role="group" aria-label={intl.formatMessage({ id: "deploy.fullAccess.title" })}>
		<div className="flex items-start gap-2.5"><ShieldAlert size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
			<div className="min-w-0">
				<p className="font-semibold text-ink">{intl.formatMessage({ id: "deploy.fullAccess.title" })}</p>
				<p className="mt-1 leading-5">{intl.formatMessage({ id: `deploy.fullAccess.reason.${run.plan.remoteAccess.reason}` })} {intl.formatMessage({ id: "deploy.fullAccess.target" }, { host: identity })}</p>
				<details className="group mt-1.5">
					<summary className="flex w-fit cursor-pointer items-center gap-1 font-medium text-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning">{intl.formatMessage({ id: "deploy.fullAccess.details" })}<ChevronDown size={13} className="transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
					<p className="mt-2 leading-5">{intl.formatMessage({ id: "deploy.fullAccess.notice" }, { host: identity })}</p>
					<p className="mt-1 break-all">{intl.formatMessage({ id: "deploy.fullAccess.fingerprint" }, { fingerprint: run.plan.targetBinding.hostKeyFingerprint })}</p>
				</details>
			</div>
		</div>
	</div>;
}

function PipelineStep({ run, stage, last, now, busy, readOnly, onDecideFullAccess }: {
	run: DeploymentRun;
	stage: DeployStage;
	last: boolean;
	now: number;
	busy: boolean;
	readOnly: boolean;
	onDecideFullAccess: Props["onDecideFullAccess"];
}) {
	const intl = useIntl();
	const view = run.stages[stage];
	const approvalStage = stage === "restart" || stage === "verify" ? stage : null;
	const approval = approvalStage ? run.fullAccessApprovals?.[approvalStage] : undefined;
	const expired = run.status === "preparing" && approval?.status === "approved" && (approval.expiresAt ?? 0) <= now;
	const needsDecision = approval?.status === "pending" || expired;
	const latestOutput = view.log.trim().split("\n").filter(Boolean).at(-1)?.slice(-180);
	const percent = view.progress && view.progress.total > 0
		? Math.min(100, Math.round(view.progress.current / view.progress.total * 100))
		: null;
	return <li data-stage={stage} data-status={view.status} aria-current={view.status === "running" ? "step" : undefined} className="relative grid min-w-0 grid-cols-[18px_minmax(0,1fr)] gap-x-3.5 pb-4 last:pb-0">
		{!last ? <span aria-hidden="true" className={["absolute bottom-0 left-[8px] top-[18px] w-px", view.status === "success" ? "bg-[var(--accent-line)]" : "bg-line"].join(" ")} /> : null}
		<span aria-hidden="true" className={["relative z-10 mt-[3px] flex h-[15px] w-[15px] items-center justify-center rounded-full border", nodeTone(view.status)].join(" ")}>
			{view.status === "running" ? <span className="pointer-events-none absolute -inset-[5px] rounded-full border border-[var(--accent-line)] motion-safe:animate-[pulse_2.8s_ease-in-out_infinite]" /> : null}
			<span className="h-1.5 w-1.5 rounded-full bg-current" />
		</span>
		<div className="min-w-0 pb-2 pt-0.5">
			<div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<h4 className="text-sm font-medium text-ink">{intl.formatMessage({ id: `deploy.stage.${stage}` })}</h4>
				<span className={["text-[11px] font-medium", statusTone(view.status)].join(" ")} aria-live={view.status === "running" ? "polite" : undefined}>{intl.formatMessage({ id: `deploy.status.${view.status}` })}</span>
			</div>
			<StepSummary run={run} stage={stage} />
			{view.progress ? <div className="mt-3 flex items-center gap-2">
				<div className="min-w-0 flex-1">
					<progress className="sr-only" value={view.progress.current} max={view.progress.total || 1} aria-label={intl.formatMessage({ id: `deploy.stage.${stage}` })} />
					<div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-accent" style={{ width: `${percent ?? 0}%` }} /></div>
				</div>
				<span className="shrink-0 text-[11px] tabular-nums text-muted">{percent === null ? "—" : String(percent) + "%"}</span>
			</div> : null}
			{view.status === "running" && latestOutput ? <p className="mt-2 line-clamp-2 break-all font-mono text-[11px] text-secondary">{latestOutput}</p> : null}
			{view.error ? <p role="alert" className="mt-2 break-words text-xs text-danger">{view.error}</p> : null}
			{view.status === "failed" && (view.exitCode !== undefined || view.failureCode || view.operationId) ? <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-secondary">
				{view.exitCode !== undefined ? <span>{intl.formatMessage({ id: "deploy.failure.exitCode" }, { code: view.exitCode })}</span> : null}
				{view.failureCode ? <span>{intl.formatMessage({ id: "deploy.failure.code" }, { code: view.failureCode })}</span> : null}
				{view.operationId ? <span className="break-all">{intl.formatMessage({ id: "deploy.failure.operationId" }, { id: view.operationId })}</span> : null}
			</p> : null}
			{approval && approvalStage ? <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-2.5">
				<p className="flex items-center gap-1 text-xs text-warning" aria-live="polite"><ShieldAlert size={13} aria-hidden="true" />Full Access · {intl.formatMessage({ id: `deploy.fullAccess.status.${expired ? "expired" : approval.status}` })}</p>
				{!readOnly && run.status === "preparing" && needsDecision ? <div className="flex flex-wrap gap-2">
					<button type="button" disabled={busy} aria-label={intl.formatMessage({ id: "deploy.fullAccess.approveStage" }, { stage: intl.formatMessage({ id: `deploy.stage.${stage}` }) })} onClick={() => onDecideFullAccess(approvalStage, approval.id, true)} className="rounded-md bg-warning px-2.5 py-1.5 text-xs font-semibold text-[var(--text-inverse)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-raised)] disabled:opacity-50">{intl.formatMessage({ id: "deploy.fullAccess.approve" })}</button>
					<button type="button" disabled={busy} aria-label={intl.formatMessage({ id: "deploy.fullAccess.rejectStage" }, { stage: intl.formatMessage({ id: `deploy.stage.${stage}` }) })} onClick={() => onDecideFullAccess(approvalStage, approval.id, false)} className="rounded-md border border-[var(--warning-line)] px-2.5 py-1.5 text-xs font-medium text-warning focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-raised)] disabled:opacity-50">{intl.formatMessage({ id: "deploy.fullAccess.reject" })}</button>
				</div> : null}
			</div> : null}
			{view.log ? <details className="group mt-2 text-xs">
				<summary aria-label={intl.formatMessage({ id: "deploy.log.showStage" }, { stage: intl.formatMessage({ id: `deploy.stage.${stage}` }) })} className="flex w-fit cursor-pointer items-center gap-1 text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{intl.formatMessage({ id: "deploy.log.show" })}<ChevronDown size={13} className="transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
				<pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line-soft bg-surface-muted p-3 font-mono text-[11px] leading-5 text-secondary">{view.log}</pre>
			</details> : null}
		</div>
	</li>;
}

function StepSummary({ run, stage }: { run: DeploymentRun; stage: DeployStage }) {
	const intl = useIntl();
	if (stage === "prepare") return <p className="mt-1 break-all text-xs text-muted">{run.plan.profilePath.split(/[\\/]/u).at(-1)} · {run.plan.target.host}</p>;
	if (stage === "build") return <>
		<p className="mt-1 break-all text-xs text-muted">{run.plan.build.cwd}</p>
		<CommandText command={run.plan.build.command} />
	</>;
	if (stage === "upload") return <>
		<dl className="mt-1.5 grid min-w-0 grid-cols-[4.75rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
			<dt className="text-muted">{intl.formatMessage({ id: "deploy.upload.source" })}</dt><dd className="min-w-0 break-all font-mono text-[11px] text-secondary">{run.plan.build.artifact}</dd>
			<dt className="text-muted">{intl.formatMessage({ id: "deploy.upload.target" })}</dt><dd className="min-w-0 break-all font-mono text-[11px] font-medium text-ink">{run.plan.upload.remotePath}</dd>
		</dl>
		<p className="mt-1 text-[11px] text-muted">{intl.formatMessage({ id: "deploy.overwrite" })}</p>
	</>;
	if (stage === "restart") return <CommandText command={run.plan.restart.command} />;
	return run.plan.verify ? <CommandText command={run.plan.verify.command} />
		: <p className="mt-1 text-xs text-muted">{intl.formatMessage({ id: "deploy.skip" })}</p>;
}

function CommandText({ command }: { command: string }) {
	return <code className="mt-2 block max-h-24 overflow-auto whitespace-pre-wrap break-all border-l-2 border-line-strong pl-2.5 font-mono text-[11px] leading-5 text-secondary">{command}</code>;
}

function nodeTone(status: DeploymentRun["stages"][DeployStage]["status"]): string {
	if (status === "success") return "border-[var(--accent-line)] bg-[var(--success-soft)] text-[var(--success)]";
	if (status === "running") return "border-[var(--accent-line)] bg-[var(--success-soft)] text-accent";
	if (status === "failed") return "border-[var(--danger-line)] bg-[var(--danger-soft)] text-danger";
	return "border-line bg-surface-raised text-faint";
}

function statusTone(status: DeploymentRun["stages"][DeployStage]["status"]): string {
	if (status === "running") return "text-accent";
	if (status === "failed") return "text-danger";
	return "text-muted";
}

function runStatusTone(status: DeploymentRun["status"]): string {
	if (status === "success" || status === "running") return "bg-[var(--success-soft)] text-accent";
	if (status === "failed") return "bg-[var(--danger-soft)] text-danger";
	return "bg-surface-muted text-secondary";
}
