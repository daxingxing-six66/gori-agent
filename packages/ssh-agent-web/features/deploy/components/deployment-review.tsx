"use client";

import { ArrowUpRight, LoaderCircle, Play } from "lucide-react";
import { useIntl } from "react-intl";
import type { DeploymentRun } from "../model/deployment";
import type { DeploymentReviewState } from "../model/deployment-review";
import { RecoveryReview } from "./deployment-plan-details";
import { DeploymentPlanOverview } from "./deployment-plan-overview";
import "./deployment-plan.css";

interface DeploymentReviewProps {
	run: DeploymentRun; review: DeploymentReviewState | null; busy: boolean; canConfirm: boolean;
	starting?: boolean; showPlan?: boolean; onConfirm(): void; onReviewPermissions(): void;
	onDecideRecovery(id: string, approved: boolean): void;
}
export type DeploymentReviewControls = Omit<DeploymentReviewProps, "run" | "showPlan"> & { runId: string };

/** Plan confirmation belongs to Deploy; exceptional command permissions stay in the conversation. */
export function DeploymentReview({ run, review, busy, canConfirm, starting = false, showPlan = run.status === "preparing", onConfirm, onReviewPermissions, onDecideRecovery }: DeploymentReviewProps) {
	const intl = useIntl();
	if (!review && !showPlan) return null;
	const initial = showPlan;
	const needsPermissions = Boolean(review?.pendingExceptions.length);
	const canStart = Boolean(review && (review.initialPlan || review.resume));
	const disabled = busy || starting || !canConfirm || needsPermissions;
	return <section className="deploy-plan-review" aria-label={intl.formatMessage({ id: "deploy.task.reviewTitle" }, { module: run.plan.module.name })}>
		{initial ? <>
			<header className="deploy-plan-heading"><h3>{intl.formatMessage({ id: "deploy.plan.title" })}</h3>
				<span className="deploy-plan-version">v{run.planRevision ?? 1}</span></header>
			<DeploymentPlanOverview key={`${run.id}:${run.planRevision ?? 1}`} plan={run.plan} />
		</> : null}
		{review?.showRecovery ? <RecoveryReview run={run} busy={busy || !canConfirm} readOnly={false} onDecide={onDecideRecovery} /> : null}
		{needsPermissions || canStart ? <div className="deploy-plan-actions">
			{needsPermissions ? <button type="button" className="deploy-plan-permissions" onClick={onReviewPermissions}>
				{intl.formatMessage({ id: "deploy.plan.permissions" })}<ArrowUpRight size={13} aria-hidden="true" /></button> : null}
			{canStart ? <button type="button" className="deploy-plan-start" disabled={disabled} aria-busy={starting} onClick={() => { if (!disabled) onConfirm(); }}>
				{starting ? <LoaderCircle size={14} className="motion-safe:animate-spin" aria-hidden="true" /> : <Play size={13} fill="currentColor" aria-hidden="true" />}
				<span>{intl.formatMessage({ id: starting ? "deploy.plan.starting" : initial ? "deploy.confirm" : "deploy.recovery.resume" })}</span>
			</button> : null}
		</div> : null}
	</section>;
}
