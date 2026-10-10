"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, Rocket, ShieldAlert, X } from "lucide-react";
import { useIntl, type IntlShape } from "react-intl";
import type { DeploymentDiscussion, DeploymentDiscovery, DeploymentRemoteStage, DeploymentRun, DeployStage } from "../model/deployment";
import { DEPLOY_STAGES, deploymentRemoteStageAccess } from "../model/deployment";
import { DeploymentModulePicker } from "./deployment-module-picker";

interface Props {
	discovery: DeploymentDiscovery | null;
	discussion?: DeploymentDiscussion | null;
	run: DeploymentRun | null;
	loading: boolean;
	busy: boolean;
	error: string | null;
	onClose(): void;
	onPlan(file: string, moduleId: string): void;
	onConfirm(): void;
	onDecideFullAccess(stage: DeploymentRemoteStage, approvalId: string, approved: boolean): void;
	onDecideRecovery(proposalId: string, approved: boolean): void;
	onDiscussRecovery(): void;
	onCancel(): void;
	onNewPlan(): void;
	onCancelDiscussion(): void;
	onRefresh(): void;
	onSetup(): void;
	canSetup: boolean;
	canPlan: boolean;
	planHint?: string;
	canConfirm: boolean;
	canRecover: boolean;
	planning: boolean;
	readOnly?: boolean;
	activity?: ReactNode;
}

const REMOTE_STAGES: readonly DeploymentRemoteStage[] = ["restart", "verify"];

export function DeploymentPanel(props: Props) {
	const intl = useIntl();
	const [now, setNow] = useState(() => Date.now());
	const profiles = props.discovery?.profiles ?? [];
	useEffect(() => {
		if ((props.run?.status !== "preparing" && props.run?.status !== "recovering") || props.run.plan.remoteAccess.mode !== "full_access") return;
		const refresh = () => setNow(Date.now());
		const initial = setTimeout(refresh, 0);
		const timer = setInterval(refresh, 1_000);
		return () => { clearTimeout(initial); clearInterval(timer); };
	}, [props.run?.id, props.run?.status, props.run?.plan.remoteAccess.mode]);

	const run = props.run;
	const fullAccessStages = run ? REMOTE_STAGES.filter((stage) => {
		const access = deploymentRemoteStageAccess(run.plan, stage);
		return run.plan[stage] && access.mode === "full_access" && access.reason !== "session_sandbox_disabled";
	}) : [];
	const approvalsNeeded = run
		? fullAccessStages.filter((stage) => {
			if (["success", "skipped"].includes(run.stages[stage].status)) return false;
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
						{intl.formatMessage({ id: run.status === "recovering" && run.recoveries?.at(-1)?.status === "pending"
							? "deploy.recovery.pendingStatus" : run.status === "recovering" && run.recoveries?.at(-1)?.status === "approved"
								? "deploy.recovery.approvedStatus" : `deploy.runStatus.${run.status}` })}
					</span> : null}
				</div>
				{run ? <p className="mt-1 min-w-0 break-words text-xs text-secondary">
					<span className="font-medium text-ink">{run.plan.project}</span>
					<span className="px-1.5 text-faint">/</span>{run.plan.module.name}
					<span className="px-1.5 text-faint">→</span>{run.plan.target.host}
				</p> : props.discussion ? <p className="mt-1 min-w-0 break-words text-xs text-secondary">
				<span className="font-medium text-ink">{props.discussion.project}</span>
				<span className="px-1.5 text-faint">/</span>{props.discussion.module.name}
				<span className="px-1.5 text-faint">→</span>{props.discussion.targetBinding.hostname}
				</p> : null}
			</div>
			<button type="button" onClick={props.onClose} aria-label={intl.formatMessage({ id: "deploy.close" })} className="shrink-0 rounded-lg p-1.5 text-muted hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><X size={18} /></button>
		</header>

		{props.error ? <p role="alert" className="mt-4 rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-xs text-danger">{props.error}</p> : null}
		{props.loading ? <p className="mt-6 text-sm text-muted">{intl.formatMessage({ id: "deploy.loading" })}</p> : null}

		{props.discussion && !run ? <div className="mt-5 rounded-xl border border-line bg-surface-muted px-4 py-3" role="status">
			<p className="text-sm font-medium text-ink">{intl.formatMessage({ id: props.discussion.status === "discussing" ? "deploy.discussion.title" : "deploy.discussion.planReady" })}</p>
			<p className="mt-1 text-xs leading-5 text-muted">{intl.formatMessage({ id: props.discussion.status === "discussing" ? "deploy.discussion.hint" : "deploy.discussion.loadingPlan" })}</p>
			{props.discussion.status === "discussing" ? <button type="button" disabled={props.busy} onClick={props.onCancelDiscussion} className="mt-3 rounded-lg border border-line px-3 py-1.5 text-xs text-secondary hover:bg-surface-hover disabled:opacity-50">{intl.formatMessage({ id: "deploy.discussion.cancel" })}</button> : null}
			{props.discussion.status === "proposed" && props.error ? <button type="button" disabled={props.busy} onClick={props.onRefresh} className="mt-3 rounded-lg border border-line px-3 py-1.5 text-xs text-secondary hover:bg-surface-hover disabled:opacity-50">{intl.formatMessage({ id: "deploy.discussion.retryPlan" })}</button> : null}
		</div> : null}

		{props.discovery && !run && !props.discussion ? <div className="mt-5 space-y-5">
			<p className="text-xs text-muted">{intl.formatMessage({ id: "deploy.host" })}: <span className="font-medium text-ink">{props.discovery.host}</span></p>
			{props.discovery.errors.map(({ file: invalidFile, message }) => <p key={invalidFile} className="rounded-lg bg-[var(--warning-soft)] px-3 py-2 text-xs text-warning">{invalidFile}: {message}</p>)}
			{profiles.length === 0 ? <div className="rounded-xl border border-dashed border-line bg-surface-muted p-4">
				<p className="text-sm font-medium text-ink">{intl.formatMessage({ id: "deploy.noProfile" })}</p>
				<p className="mt-1 text-xs text-muted">{intl.formatMessage({ id: "deploy.setupHint" })}</p>
				<button type="button" disabled={props.busy || !props.canSetup} onClick={props.onSetup} className="mt-4 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-[var(--text-inverse)] hover:bg-accent-hover disabled:opacity-50">{intl.formatMessage({ id: "deploy.setup" })}</button>
				{!props.canSetup ? <p className="mt-2 text-xs text-muted">{intl.formatMessage({ id: "deploy.selectModel" })}</p> : null}
			</div> : <>
				<DeploymentModulePicker profiles={profiles} busy={props.planning} disabled={!props.canPlan} onSelect={props.onPlan} />
				{!props.planning && props.planHint ? <p className="text-xs text-muted">{props.planHint}</p> : null}
			</>}
		</div> : null}

		{run ? <>
			{run.plan.remoteAccess.mode === "full_access" && run.plan.remoteAccess.reason === "session_sandbox_disabled"
				? <p className="mt-4 text-xs text-warning">{intl.formatMessage({ id: "session.sandbox.disabledDescription" })}</p> : null}
			{fullAccessStages.length > 0 ? <FullAccessNotice run={run} stages={fullAccessStages} /> : null}
			<div className="mt-6 flex flex-wrap items-baseline justify-between gap-2">
				<h3 className="text-sm font-semibold text-ink">{intl.formatMessage({ id: "deploy.pipeline" })}</h3>
				<span className="text-xs tabular-nums text-muted">{intl.formatMessage({ id: "deploy.pipeline.progress" }, { completed: completedStages, total: DEPLOY_STAGES.length })}</span>
			</div>
			<ol aria-label={intl.formatMessage({ id: "deploy.pipeline" })} className="mt-5">
				{DEPLOY_STAGES.map((stage, index) => <PipelineStep key={stage} run={run} stage={stage} last={index === DEPLOY_STAGES.length - 1}
					now={now} busy={props.busy} readOnly={props.readOnly === true} onDecideFullAccess={props.onDecideFullAccess} />)}
			</ol>
			{run.status === "recovering" ? <RecoveryReview run={run} busy={props.busy} readOnly={props.readOnly === true}
				onDecide={props.onDecideRecovery} /> : null}
			{run.error && !stageErrors.has(run.error) ? <p role="alert" className="mt-4 rounded-lg bg-[var(--danger-soft)] p-3 text-xs text-danger">{run.error}</p> : null}
			{props.activity}
			{!props.readOnly ? <footer className="mt-5 flex flex-wrap items-center gap-3 border-t border-line-soft pt-4">
				{run.status === "preparing" || (run.status === "recovering" && run.recoveries?.at(-1)?.status === "approved") ? <button type="button" disabled={props.busy || approvalsNeeded > 0 || !props.canConfirm} onClick={props.onConfirm} className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-[var(--text-inverse)] hover:bg-accent-hover disabled:opacity-50">{intl.formatMessage({ id: run.status === "recovering" ? "deploy.recovery.resume" : "deploy.confirm" })}</button> : null}
				{(run.status === "preparing" || run.status === "recovering") && approvalsNeeded > 0 && run.recoveries?.at(-1)?.status !== "pending" ? <span className="text-xs text-warning" aria-live="polite">{intl.formatMessage({ id: "deploy.fullAccess.waiting" }, { count: approvalsNeeded })}</span> : null}
				{run.status === "preparing" && !props.canConfirm ? <span className="text-xs text-muted">{intl.formatMessage({ id: "deploy.selectModelExecution" })}</span> : null}
				{run.status === "recovering" && run.recoveries?.at(-1)?.status !== "pending" && run.recoveries?.at(-1)?.status !== "approved" ? <button type="button" disabled={props.busy || !props.canRecover} onClick={props.onDiscussRecovery} className="rounded-lg border border-line px-4 py-2 text-xs font-medium text-ink hover:bg-surface-hover disabled:opacity-50">{intl.formatMessage({ id: "deploy.recovery.discuss" })}</button> : null}
				{run.status === "preparing" || run.status === "running" || run.status === "recovering"
					? <button type="button" disabled={props.busy} onClick={props.onCancel} className="rounded-lg border border-line px-4 py-2 text-xs text-secondary hover:bg-surface-hover disabled:opacity-50">{intl.formatMessage({ id: "deploy.cancel" })}</button>
					: <button type="button" onClick={props.onNewPlan} className="rounded-lg border border-line px-4 py-2 text-xs text-secondary hover:bg-surface-hover">{intl.formatMessage({ id: "deploy.newPlan" })}</button>}
			</footer> : null}
		</> : null}
	</section>;
}

function FullAccessNotice({ run, stages }: { run: DeploymentRun; stages: readonly DeploymentRemoteStage[] }) {
	const intl = useIntl();
	const identity = [run.plan.targetBinding.remoteUser, "@", run.plan.target.host, ":", run.plan.targetBinding.port].join("");
	return <details className="group mt-4 rounded-lg border border-[var(--warning-line)] bg-[var(--warning-soft)] px-3 py-2.5 text-xs text-warning" role="group" aria-label={intl.formatMessage({ id: "deploy.fullAccess.title" })}>
		<summary className="chat-disclosure-trigger flex w-full gap-2 !text-warning"><ShieldAlert size={14} aria-hidden="true" /><span className="flex-1">{intl.formatMessage({ id: "deploy.fullAccess.compact" })}</span><ChevronDown size={14} className="transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
		<div className="mt-3 border-t border-[var(--warning-line)] pt-3 leading-5 text-secondary">
			<p>{intl.formatMessage({ id: "deploy.fullAccess.notice" }, { host: identity })}</p>
			<ul className="mt-2 space-y-1">{stages.map((stage) => {
				const access = deploymentRemoteStageAccess(run.plan, stage);
				return access.mode === "full_access" && access.reason !== "session_sandbox_disabled" ? <li key={stage}>
					<span className="font-semibold">{intl.formatMessage({ id: `deploy.stage.${stage}` })}：</span>
					{intl.formatMessage({ id: `deploy.fullAccess.reason.${access.reason}` })}
				</li> : null;
			})}</ul>
			<p className="mt-1 break-all">{intl.formatMessage({ id: "deploy.fullAccess.fingerprint" }, { fingerprint: run.plan.targetBinding.hostKeyFingerprint })}</p>
		</div>
	</details>;
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
	const expired = (run.status === "preparing" || run.status === "recovering") && approval?.status === "approved" && (approval.expiresAt ?? 0) <= now;
	const needsDecision = approval?.status === "pending" || expired;
	const needsReview = !readOnly && view.status !== "success" && view.status !== "skipped" &&
		(run.status === "preparing" || run.status === "recovering") && needsDecision &&
		run.recoveries?.at(-1)?.status !== "pending";
	const latestOutput = view.log.trim().split("\n").filter(Boolean).at(-1)?.slice(-180);
	const attempts = stage === "prepare" ? [] : run.stageAttempts?.[stage] ?? [];
	const previousAttempts = view.status === "pending" || view.status === "running" ? attempts : attempts.slice(0, -1);
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
			<p className="mt-0.5 text-xs text-muted">{stepSubtitle(run, stage, intl.formatMessage)}</p>
			{view.progress ? <div className="mt-3 flex items-center gap-2">
				<div className="min-w-0 flex-1">
					<progress className="sr-only" value={view.progress.current} max={view.progress.total || 1} aria-label={intl.formatMessage({ id: `deploy.stage.${stage}` })} />
					<div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-accent" style={{ width: `${percent ?? 0}%` }} /></div>
				</div>
				<span className="shrink-0 text-[11px] tabular-nums text-muted">{percent === null ? "—" : String(percent) + "%"}</span>
			</div> : null}
			{view.status === "running" && latestOutput ? <p className="mt-1 truncate font-mono text-[11px] text-secondary">{latestOutput}</p> : null}
			{view.error ? <p role="alert" className="mt-1 line-clamp-2 break-words text-xs text-danger">{view.error}</p> : null}
			{approval && view.status !== "success" ? <p className="mt-1 flex items-center gap-1 text-[11px] text-warning"><ShieldAlert size={12} aria-hidden="true" />{approval.toolName === "remote_sandbox_exception" ? `${intl.formatMessage({ id: "deploy.fullAccess.exception" })} · ` : ""}Full Access · {intl.formatMessage({ id: `deploy.fullAccess.status.${expired ? "expired" : approval.status}` })}</p> : null}
			<details className="group mt-2 text-xs">
				<summary className={`chat-disclosure-trigger ${needsReview ? "!text-warning" : ""}`}>{intl.formatMessage({ id: needsReview ? "deploy.stage.review" : "deploy.stage.details" })}<ChevronDown size={14} className="transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
				<div className="mt-2 rounded-lg border border-line-soft bg-surface-muted px-3 py-2.5">
					<StepSummary run={run} stage={stage} />
					{view.status === "failed" && (view.exitCode !== undefined || view.failureCode || view.operationId) ? <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-secondary">
						{view.exitCode !== undefined ? <span>{intl.formatMessage({ id: "deploy.failure.exitCode" }, { code: view.exitCode })}</span> : null}
						{view.failureCode ? <span>{intl.formatMessage({ id: "deploy.failure.code" }, { code: view.failureCode })}</span> : null}
						{view.operationId ? <span className="break-all">{intl.formatMessage({ id: "deploy.failure.operationId" }, { id: view.operationId })}</span> : null}
					</p> : null}
					{needsReview && approval && approvalStage ? <div className="mt-3 flex flex-wrap gap-2 border-t border-line-soft pt-3">
						<button type="button" disabled={busy} aria-label={intl.formatMessage({ id: "deploy.fullAccess.approveStage" }, { stage: intl.formatMessage({ id: `deploy.stage.${stage}` }) })} onClick={() => onDecideFullAccess(approvalStage, approval.id, true)} className="rounded-md bg-warning px-2.5 py-1.5 text-xs font-semibold text-[var(--text-inverse)] disabled:opacity-50">{intl.formatMessage({ id: "deploy.fullAccess.approve" })}</button>
						<button type="button" disabled={busy} aria-label={intl.formatMessage({ id: "deploy.fullAccess.rejectStage" }, { stage: intl.formatMessage({ id: `deploy.stage.${stage}` }) })} onClick={() => onDecideFullAccess(approvalStage, approval.id, false)} className="rounded-md border border-[var(--warning-line)] px-2.5 py-1.5 text-xs text-warning disabled:opacity-50">{intl.formatMessage({ id: "deploy.fullAccess.reject" })}</button>
					</div> : null}
					{view.log ? <details className="group mt-3 border-t border-line-soft pt-2"><summary aria-label={intl.formatMessage({ id: "deploy.log.showStage" }, { stage: intl.formatMessage({ id: `deploy.stage.${stage}` }) })} className="chat-disclosure-trigger">{intl.formatMessage({ id: "deploy.log.show" })}<ChevronDown size={14} className="transition-transform group-open:rotate-180" aria-hidden="true" /></summary><pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-5 text-secondary">{view.log}</pre></details> : null}
					{previousAttempts.length > 0 ? <details className="group mt-3 border-t border-line-soft pt-2"><summary className="chat-disclosure-trigger">{intl.formatMessage({ id: "deploy.recovery.attempts" }, { count: previousAttempts.length })}<ChevronDown size={14} className="transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
						<ol className="mt-2 space-y-3">{previousAttempts.map((attempt, index) => <li key={`${index}:${attempt.planRevision}`} className="border-l-2 border-line-strong pl-2">
							<p className="text-[11px] text-secondary">{intl.formatMessage({ id: "deploy.recovery.attempt" }, { number: index + 1, revision: attempt.planRevision })} · {intl.formatMessage({ id: `deploy.status.${attempt.result.status}` })}</p>
							{attempt.result.error ? <p className="mt-1 text-danger">{attempt.result.error}</p> : null}
							{attempt.result.log ? <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">{attempt.result.log}</pre> : null}
						</li>)}</ol>
					</details> : null}
				</div>
			</details>
		</div>
	</li>;
}

function stepSubtitle(run: DeploymentRun, stage: DeployStage, formatMessage: IntlShape["formatMessage"]): string {
	if (stage === "prepare") return run.plan.profilePath.split(/[\\/]/u).at(-1) ?? "";
	if (stage === "build") return formatMessage({ id: "deploy.stage.buildCount" }, { count: run.plan.version === 2 ? run.plan.buildSteps.length : 1 });
	if (stage === "upload") return formatMessage({ id: "deploy.stage.uploadCount" }, { count: run.plan.version === 2 ? run.plan.artifacts.length : 1 });
	if (stage === "verify" && !run.plan.verify) return formatMessage({ id: "deploy.skip" });
	return formatMessage({ id: "deploy.stage.remoteCommand" });
}

function RecoveryReview({ run, busy, readOnly, onDecide }: {
	run: DeploymentRun;
	busy: boolean;
	readOnly: boolean;
	onDecide(proposalId: string, approved: boolean): void;
}) {
	const intl = useIntl();
	const proposal = run.recoveries?.at(-1);
	if (!proposal || proposal.status === "rejected") return null;
	if (proposal.status === "approved") return <p className="mt-3 rounded-lg bg-[var(--success-soft)] px-3 py-2 text-xs text-accent">{intl.formatMessage({ id: "deploy.recovery.approved" })}</p>;
	return <section className="mt-4 rounded-xl border border-[var(--warning-line)] bg-[var(--warning-soft)] px-4 py-3" aria-label={intl.formatMessage({ id: "deploy.recovery.title" })}>
		<p className="text-sm font-medium text-ink">{intl.formatMessage({ id: "deploy.recovery.title" })} · {intl.formatMessage({ id: `deploy.stage.${proposal.stage}` })}</p>
		<p className="mt-1 text-xs leading-5 text-secondary">{proposal.reason}</p>
		<details className="group mt-3 text-xs">
			<summary className="chat-disclosure-trigger !text-warning">{intl.formatMessage({ id: "deploy.recovery.review" })}<ChevronDown size={14} className="transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
			<div className="mt-3 grid gap-2 sm:grid-cols-2">
				<div className="min-w-0 rounded-lg border border-line bg-surface-raised p-3"><p className="font-medium text-muted">{intl.formatMessage({ id: "deploy.recovery.before" })}</p><StepSummary run={run} stage={proposal.stage} /></div>
				<div className="min-w-0 rounded-lg border border-line bg-surface-raised p-3"><p className="font-medium text-accent">{intl.formatMessage({ id: "deploy.recovery.after" })}</p><StepSummary run={{ ...run, plan: proposal.plan }} stage={proposal.stage} /></div>
			</div>
			{proposal.stage === "build" && run.plan.version === 2 && JSON.stringify(run.plan.artifacts) !== JSON.stringify(proposal.plan.artifacts)
				? <div className="mt-3"><p className="font-medium text-ink">{intl.formatMessage({ id: "deploy.stage.upload" })}</p><div className="mt-2 grid gap-2 sm:grid-cols-2">
					<div className="min-w-0 rounded-lg border border-line bg-surface-raised p-3"><p className="font-medium text-muted">{intl.formatMessage({ id: "deploy.recovery.before" })}</p><StepSummary run={run} stage="upload" /></div>
					<div className="min-w-0 rounded-lg border border-line bg-surface-raised p-3"><p className="font-medium text-accent">{intl.formatMessage({ id: "deploy.recovery.after" })}</p><StepSummary run={{ ...run, plan: proposal.plan }} stage="upload" /></div>
				</div></div> : null}
			{proposal.stage !== "build" ? <p className="mt-3 text-xs leading-5 text-warning">{intl.formatMessage({ id: "deploy.recovery.effects" })}</p> : null}
			{!readOnly ? <div className="mt-3 flex flex-wrap gap-2">
				<button type="button" disabled={busy} onClick={() => onDecide(proposal.id, true)} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-[var(--text-inverse)] disabled:opacity-50">{intl.formatMessage({ id: "deploy.recovery.approve" })}</button>
				<button type="button" disabled={busy} onClick={() => onDecide(proposal.id, false)} className="rounded-lg border border-line px-3 py-1.5 text-xs text-secondary disabled:opacity-50">{intl.formatMessage({ id: "deploy.recovery.reject" })}</button>
			</div> : null}
		</details>
	</section>;
}

function StepSummary({ run, stage }: { run: DeploymentRun; stage: DeployStage }) {
	const intl = useIntl();
	if (stage === "prepare") return <p className="mt-1 break-all text-xs text-muted">{run.plan.profilePath.split(/[\\/]/u).at(-1)} · {run.plan.target.host}</p>;
	if (stage === "build") {
		const steps = run.plan.version === 2 ? run.plan.buildSteps : [run.plan.build];
		return <ol className="mt-1 space-y-2">
			{steps.map((step, index) => <li key={`${index}:${step.cwd}:${step.command}`} className="min-w-0">
				<p className="break-all text-xs text-muted">{steps.length > 1 ? `${index + 1}. ` : ""}{step.cwd}</p>
				<CommandText command={step.command} />
			</li>)}
		</ol>;
	}
	if (stage === "upload") {
		const artifacts = run.plan.version === 2 ? run.plan.artifacts
			: [{ source: run.plan.build.artifact, remotePath: run.plan.upload.remotePath }];
		return <div className="mt-1.5">
			<ol className="space-y-1.5 font-mono text-[11px] leading-5 text-secondary">
				{artifacts.map((artifact, index) => <li key={`${artifact.source}:${artifact.remotePath}`} className="min-w-0 break-all">
					{artifacts.length > 1 ? `${index + 1}. ` : ""}<span className="sr-only">{intl.formatMessage({ id: "deploy.upload.source" })}: </span><span>{artifact.source}</span><span aria-hidden="true" className="px-1 text-muted">→</span><span className="sr-only">{intl.formatMessage({ id: "deploy.upload.target" })}: </span><span className="font-medium text-ink">{artifact.remotePath}</span>
				</li>)}
			</ol>
			<p className="mt-1 text-[11px] text-muted">{intl.formatMessage({ id: "deploy.overwrite" })}</p>
		</div>;
	}
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
	if (status === "recovering") return "bg-[var(--warning-soft)] text-warning";
	if (status === "failed") return "bg-[var(--danger-soft)] text-danger";
	return "bg-surface-muted text-secondary";
}
