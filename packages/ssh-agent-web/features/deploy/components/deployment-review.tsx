"use client";

import { useIntl } from "react-intl";
import { DEPLOY_STAGES, type DeploymentRemoteStage, type DeploymentRun } from "../model/deployment";
import type { DeploymentReviewState } from "../model/deployment-review";
import { RecoveryReview, StepSummary } from "./deployment-plan-details";
import { DeploymentFullAccessReview } from "./deployment-full-access-review";

/** Plan decisions belong to the Agent conversation, independent of the open task page. */
export function DeploymentReview({ run, review, busy, canConfirm, onConfirm, onDecideFullAccess, onDecideRecovery }: {
	run: DeploymentRun; review: DeploymentReviewState | null; busy: boolean; canConfirm: boolean; onConfirm(): void;
	onDecideFullAccess(stage: DeploymentRemoteStage, id: string, approved: boolean): void;
	onDecideRecovery(id: string, approved: boolean): void;
}) {
	const intl = useIntl();
	if (!review) return null;
	return <section className="rounded-xl border border-line bg-surface-raised p-4" aria-label={intl.formatMessage({ id: "deploy.task.reviewTitle" }, { module: run.plan.module.name })}>
		<h3 className="text-sm font-semibold text-ink">{intl.formatMessage({ id: "deploy.task.reviewTitle" }, { module: run.plan.module.name })}</h3>
		<p className="mt-1 break-all text-xs text-muted">{run.plan.target.host}</p>
		{review.initialPlan ? <div className="mt-4 grid gap-4">{DEPLOY_STAGES.slice(1).map((stage) => <div key={stage}>
			<h4 className="text-xs font-medium text-secondary">{intl.formatMessage({ id: `deploy.stage.${stage}` })}</h4><StepSummary run={run} stage={stage} />
		</div>)}</div> : null}
		{review.showRecovery ? <RecoveryReview run={run} busy={busy} readOnly={false} onDecide={onDecideRecovery} /> : null}
		<DeploymentFullAccessReview run={run} stages={review.exceptionStages} pendingStages={review.pendingExceptions} busy={busy} onDecide={onDecideFullAccess} />
		{review.initialPlan || review.resume ? <button type="button" disabled={busy || !canConfirm || review.pendingExceptions.length > 0} onClick={onConfirm}
			className="mt-4 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-[var(--text-inverse)] disabled:opacity-50">
			{intl.formatMessage({ id: review.initialPlan ? "deploy.confirm" : "deploy.recovery.resume" })}</button> : null}
	</section>;
}
