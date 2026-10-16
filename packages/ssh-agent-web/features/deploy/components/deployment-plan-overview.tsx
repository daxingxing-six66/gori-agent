"use client";

import { ArrowRight, ChevronDown, FileArchive } from "lucide-react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import type { DeploymentPlan } from "../model/deployment";
import { DeploymentStageIcon } from "./deployment-stage-icon";

/** Summary first, with exact commands and paths available without leaving the plan. */
export function DeploymentPlanOverview({ plan }: { plan: DeploymentPlan }) {
	const intl = useIntl();
	const steps = plan.version === 2 ? plan.buildSteps : [plan.build];
	const artifacts = plan.version === 2 ? plan.artifacts : [{ source: plan.build.artifact, remotePath: plan.upload.remotePath }];
	return <ol className="deploy-plan-overview">
		<PlanSection icon={<DeploymentStageIcon stage="build" />} title={intl.formatMessage({ id: "deploy.stage.build" })}
			meta={intl.formatMessage({ id: "deploy.stage.buildCount" }, { count: steps.length })}>
			<ol className="deploy-plan-builds">{steps.map((step, index) => <li key={`${index}:${step.cwd}:${step.command}`}>
				<div className="deploy-plan-step-heading"><span>{String(index + 1).padStart(2, "0")}</span><code title={step.cwd}>{step.cwd}</code></div>
				<pre className="deploy-plan-command" tabIndex={0}><code>{step.command}</code></pre>
			</li>)}</ol>
		</PlanSection>
		<PlanSection icon={<DeploymentStageIcon stage="upload" />} title={intl.formatMessage({ id: "deploy.stage.upload" })}
			meta={intl.formatMessage({ id: "deploy.stage.uploadCount" }, { count: artifacts.length })}>
			<ul className="deploy-plan-artifacts">{artifacts.map((artifact) => <li key={`${artifact.source}:${artifact.remotePath}`}>
				<details className="deploy-plan-artifact"><summary>
					<FileArchive size={14} aria-hidden="true" /><span className="deploy-plan-file" title={artifact.source}>{artifact.source.split(/[\\/]/u).at(-1)}</span>
					<ArrowRight size={12} aria-hidden="true" /><span className="deploy-plan-destination" title={artifact.remotePath}>{artifact.remotePath}</span><ChevronDown size={12} aria-hidden="true" />
				</summary><dl>
					<dt>{intl.formatMessage({ id: "deploy.upload.source" })}</dt><dd><code>{artifact.source}</code></dd>
					<dt>{intl.formatMessage({ id: "deploy.upload.target" })}</dt><dd><code>{artifact.remotePath}</code></dd>
				</dl></details>
			</li>)}</ul>
			<p className="deploy-plan-overwrite">{intl.formatMessage({ id: "deploy.overwrite" })}</p>
		</PlanSection>
		<PlanSection icon={<DeploymentStageIcon stage="restart" />} title={intl.formatMessage({ id: "deploy.stage.restart" })}
			meta={intl.formatMessage({ id: "deploy.plan.remote" })}>
			<pre className="deploy-plan-command" tabIndex={0}><code>{plan.restart.command}</code></pre>
		</PlanSection>
		<PlanSection icon={<DeploymentStageIcon stage="verify" />} title={intl.formatMessage({ id: "deploy.stage.verify" })}
			meta={intl.formatMessage({ id: plan.verify ? "deploy.plan.configured" : "deploy.skip" })}>
			{plan.verify ? <pre className="deploy-plan-command" tabIndex={0}><code>{plan.verify.command}</code></pre>
				: <p className="deploy-plan-overwrite">{intl.formatMessage({ id: "deploy.skip" })}</p>}
		</PlanSection>
	</ol>;
}

function PlanSection({ icon, title, meta, children }: {
	icon: ReactNode; title: string; meta: string; children: ReactNode;
}) {
	return <li className="deploy-plan-node"><details className="deploy-plan-section"><summary>
		<span className="deploy-plan-icon" aria-hidden="true">{icon}</span><span className="deploy-plan-section-title">{title}</span>
		<span className="deploy-plan-meta">{meta}</span><ChevronDown size={14} aria-hidden="true" />
	</summary><div className="deploy-plan-section-content"><div className="deploy-plan-card">{children}</div></div></details></li>;
}
