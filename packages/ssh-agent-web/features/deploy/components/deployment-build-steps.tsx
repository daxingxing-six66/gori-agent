"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useIntl } from "react-intl";
import type { DeploymentRun } from "../model/deployment";

/** Browsing commands never changes the backend's current execution step. */
export function DeploymentBuildSteps({ run }: { run: DeploymentRun }) {
	const intl = useIntl();
	const steps = run.plan.version === 2 ? run.plan.buildSteps : [run.plan.build];
	const actual = run.stages.build.step;
	const latest = Math.min(steps.length - 1, Math.max(0, (actual?.current ?? (run.stages.build.status === "success" ? steps.length : 1)) - 1));
	const scope = `${run.id}:${run.planRevision ?? 1}:${run.stages.build.executionId ?? ""}`;
	const [selected, setSelected] = useState<{ scope: string; index: number } | null>(null);
	const index = selected?.scope === scope ? Math.min(selected.index, steps.length - 1) : latest;
	const step = actual && index === actual.current - 1 ? actual : steps[index];
	if (!step) return null;
	return <div className="deploy-build-step">
		<nav className="deploy-build-step-nav" aria-label={intl.formatMessage({ id: "deploy.task.steps" })}>
			<span>{intl.formatMessage({ id: "deploy.task.steps" })}</span>
			<button type="button" disabled={index === 0} aria-label={intl.formatMessage({ id: "deploy.task.previousStep" })}
				onClick={() => { if (index > 0) setSelected({ scope, index: index - 1 }); }}><ChevronLeft size={14} aria-hidden="true" /></button>
			<span className="deploy-build-step-count" aria-live="polite" aria-label={intl.formatMessage({ id: "deploy.task.step" }, { current: index + 1, total: steps.length })}>{index + 1}/{steps.length}</span>
			<button type="button" disabled={index === steps.length - 1} aria-label={intl.formatMessage({ id: "deploy.task.nextStep" })}
				onClick={() => { if (index < steps.length - 1) setSelected({ scope, index: index + 1 }); }}><ChevronRight size={14} aria-hidden="true" /></button>
		</nav>
		<blockquote className="deploy-build-command"><pre tabIndex={0}><code>{step.command}</code></pre></blockquote>
	</div>;
}
