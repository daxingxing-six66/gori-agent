"use client";

import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { DEPLOY_STAGES, deploymentRemoteStageAccess, type DeploymentRemoteStage, type DeploymentRun } from "../model/deployment";
import { FullAccessNotice, RecoveryReview, StepSummary } from "./deployment-plan-details";
import { deploymentAwaitsResume } from "../model/deployment-task";

/** Plan decisions belong to the Agent conversation, independent of the open task page. */
export function DeploymentReview({ run, busy, canConfirm, onConfirm, onDecideFullAccess, onDecideRecovery, onDiscussRecovery }: {
	run: DeploymentRun; busy: boolean; canConfirm: boolean; onConfirm(): void;
	onDecideFullAccess(stage: DeploymentRemoteStage, id: string, approved: boolean): void;
	onDecideRecovery(id: string, approved: boolean): void; onDiscussRecovery(): void;
}) {
	const intl = useIntl();
	const [now, setNow] = useState(Date.now);
	useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(timer); }, []);
	const exceptionStages = (["restart", "verify"] as const).filter((stage) => {
		const access = deploymentRemoteStageAccess(run.plan, stage);
		return run.plan[stage] && access.mode === "full_access" && access.reason !== "session_sandbox_disabled";
	});
	const review = run.recoveries?.at(-1);
	const needed = exceptionStages.filter((stage) => !["success", "skipped"].includes(run.stages[stage].status) &&
		(run.fullAccessApprovals?.[stage]?.status !== "approved" || (run.fullAccessApprovals?.[stage]?.expiresAt ?? 0) <= now));
	return <section className="rounded-xl border border-line bg-surface-raised p-4" aria-label={intl.formatMessage({ id: "deploy.task.reviewTitle" }, { module: run.plan.module.name })}>
		<h3 className="text-sm font-semibold text-ink">{intl.formatMessage({ id: "deploy.task.reviewTitle" }, { module: run.plan.module.name })}</h3>
		<p className="mt-1 break-all text-xs text-muted">{run.plan.target.host}</p>
		{run.status === "preparing" ? <div className="mt-4 grid gap-4">{DEPLOY_STAGES.slice(1).map((stage) => <div key={stage}>
			<h4 className="text-xs font-medium text-secondary">{intl.formatMessage({ id: `deploy.stage.${stage}` })}</h4><StepSummary run={run} stage={stage} />
		</div>)}</div> : review?.status !== "approved" || deploymentAwaitsResume(run) ? <RecoveryReview run={run} busy={busy} readOnly={false} onDecide={onDecideRecovery} /> : null}
		{exceptionStages.length > 0 ? <FullAccessNotice run={run} stages={exceptionStages} /> : null}
		{review?.status !== "pending" ? needed.map((stage) => {
			const approval = run.fullAccessApprovals?.[stage];
			if (!approval) return null;
			return <div key={approval.id} className="mt-3 rounded-lg border border-[var(--warning-line)] p-3">
				<p className="text-xs text-warning">{intl.formatMessage({ id: `deploy.stage.${stage}` })} · Full Access</p>
				<code className="my-2 block break-all text-xs text-secondary">{approval.command}</code>
				<div className="flex gap-2">{[true, false].map((approved) => <button key={String(approved)} type="button" disabled={busy}
					aria-label={intl.formatMessage({ id: approved ? "deploy.fullAccess.approveStage" : "deploy.fullAccess.rejectStage" }, { stage: intl.formatMessage({ id: `deploy.stage.${stage}` }) })}
					onClick={() => onDecideFullAccess(stage, approval.id, approved)} className="rounded-md border border-line px-3 py-1.5 text-xs text-ink disabled:opacity-50">
					{intl.formatMessage({ id: approved ? "deploy.fullAccess.approve" : "deploy.fullAccess.reject" })}</button>)}</div>
			</div>;
		}) : null}
		{run.status === "preparing" || deploymentAwaitsResume(run) ? <button type="button" disabled={busy || !canConfirm || needed.length > 0} onClick={onConfirm}
			className="mt-4 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-[var(--text-inverse)] disabled:opacity-50">
			{intl.formatMessage({ id: run.status === "preparing" ? "deploy.confirm" : "deploy.recovery.resume" })}</button>
			: review?.status !== "pending" ? <button type="button" disabled={busy || !canConfirm} onClick={onDiscussRecovery} className="mt-4 rounded-lg border border-line px-3 py-2 text-xs text-ink disabled:opacity-50">
				{intl.formatMessage({ id: "deploy.recovery.discuss" })}</button> : null}
	</section>;
}
