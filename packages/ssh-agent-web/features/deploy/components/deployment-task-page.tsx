"use client";

import { Clock3, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import type { DeploymentDiscussion, DeploymentRun } from "../model/deployment";
import type { DeploymentTask } from "../model/deployment-task";
import { deploymentHasExecution } from "../model/deployment-review";
import type { DeploymentLogStore } from "../runtime/deployment-log-store";
import { DeploymentPipeline, DeploymentStatusIcon } from "./deployment-pipeline";
import { DeploymentReview, type DeploymentReviewControls } from "./deployment-review";
import "./deployment-task.css";

export function DeploymentTaskPage({ sessionId, task, run, discussion, logs, loading, busy, error,
	fullscreen, pending, review, onExit, onReturnConversation, onSubmit }: {
	sessionId: string; task: DeploymentTask | null; run: DeploymentRun | null; discussion: DeploymentDiscussion | null;
	logs: DeploymentLogStore; loading: boolean; busy: boolean; error: string | null;
	fullscreen: boolean; pending: boolean; review?: DeploymentReviewControls;
	onExit?: () => void; onReturnConversation(): void; onSubmit(message: string): Promise<boolean>;
}) {
	const intl = useIntl();
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const scope = useMemo(() => ({ sessionId }), [sessionId]);
	const currentScope = useRef(scope);
	currentScope.current = scope;
	const sendRequest = useRef<symbol | null>(null);
	useEffect(() => { sendRequest.current = null; setDraft(""); setSending(false); }, [scope]);
	const status = task?.deployment.outcome ?? (run ? run.status === "preparing" ? "review" : run.status : discussion ? "discussion" : null);
	const title = task?.deployment.title ?? run?.plan.module.name ?? discussion?.module.name;
	const controls = run && review?.runId === run.id && !task?.deployment.outcome ? review : undefined;
	const hasExecution = run ? deploymentHasExecution(run) : false;
	return <section className="deploy-task-page" aria-label="Deploy">
		{error ? <p role="alert" className="deploy-task-error">{error}</p> : null}
		{loading ? <p role="status" className="deploy-task-empty">{intl.formatMessage({ id: "deploy.loading" })}</p> : null}
		{title ? <header className="deploy-task-heading"><div><h2>{title}</h2><p>{run?.plan.target.host ?? discussion?.targetBinding.hostname}</p></div>
			{status ? <span className="deploy-task-state" data-status={status}>{status === "review" ? <Clock3 size={15} aria-hidden="true" /> : <DeploymentStatusIcon status={status === "success" ? "success" : status === "failed" || status === "recovering" ? "failed" : status === "running" ? "running" : "pending"} />}
				{intl.formatMessage({ id: status === "review" || status === "discussion" ? `deploy.task.${status}` : `deploy.runStatus.${status}` })}</span> : null}</header> : null}

		{run && (!hasExecution || controls) ? <DeploymentReview run={run} review={controls?.review ?? null} showPlan={!hasExecution}
			busy={busy || controls?.busy === true} canConfirm={controls?.canConfirm ?? false} starting={controls?.starting}
			onConfirm={controls?.onConfirm ?? noop} onReviewPermissions={controls?.onReviewPermissions ?? onReturnConversation}
			onDecideRecovery={controls?.onDecideRecovery ?? noop} /> : null}
		{run && hasExecution ? <DeploymentPipeline key={run.id} run={run} task={task} logs={logs} /> : null}

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

function noop() {}
