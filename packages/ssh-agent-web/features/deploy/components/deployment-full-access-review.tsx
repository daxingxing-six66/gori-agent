"use client";

import { useIntl } from "react-intl";
import type { DeploymentRemoteStage, DeploymentRun } from "../model/deployment";
import { FullAccessNotice } from "./deployment-plan-details";

/** Presents exact command permissions; diagnosis and stage progression are outside this component. */
export function DeploymentFullAccessReview({ run, stages, pendingStages, busy, onDecide }: {
	run: DeploymentRun;
	stages: DeploymentRemoteStage[];
	pendingStages: DeploymentRemoteStage[];
	busy: boolean;
	onDecide(stage: DeploymentRemoteStage, id: string, approved: boolean): void;
}) {
	const intl = useIntl();
	return <>
		{stages.length > 0 ? <FullAccessNotice run={run} stages={stages} /> : null}
		{pendingStages.map((stage) => {
			const approval = run.fullAccessApprovals?.[stage];
			if (!approval) return null;
			return <div key={approval.id} className="mt-3 rounded-lg border border-[var(--warning-line)] p-3">
				<p className="text-xs text-warning">{intl.formatMessage({ id: `deploy.stage.${stage}` })} · Full Access</p>
				<code className="my-2 block break-all text-xs text-secondary">{approval.command}</code>
				<div className="flex gap-2">{[true, false].map((approved) => <button key={String(approved)} type="button" disabled={busy}
					aria-label={intl.formatMessage({ id: approved ? "deploy.fullAccess.approveStage" : "deploy.fullAccess.rejectStage" }, { stage: intl.formatMessage({ id: `deploy.stage.${stage}` }) })}
					onClick={() => onDecide(stage, approval.id, approved)} className="rounded-md border border-line px-3 py-1.5 text-xs text-ink disabled:opacity-50">
					{intl.formatMessage({ id: approved ? "deploy.fullAccess.approve" : "deploy.fullAccess.reject" })}</button>)}</div>
			</div>;
		})}
	</>;
}
