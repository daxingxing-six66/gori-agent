"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import type { ChatRun } from "@/features/chat/model/chat";
import type { LlmModel, ThinkingLevel } from "@/features/llm-provider/model/llm-provider";
import type { DeploymentRun } from "../model/deployment";
import { deploymentAwaitsResume } from "../model/deployment-review";

interface ExecutionRequest {
	message: string; attachments: []; model: Pick<LlmModel, "id" | "providerId">; thinkingLevel: ThinkingLevel;
	behavior: "follow_up"; serverInteractionMode: "command" | "terminal";
	workflow: "deployment_execution"; deploymentRunId: string;
}

/** Start intent only. A successful backend claim, not this click, creates the executing pipeline. */
export function useDeploymentExecution(options: {
	sessionId: string; run: DeploymentRun | null; model: Pick<LlmModel, "id" | "providerId"> | null;
	thinkingLevel: ThinkingLevel; serverInteractionMode: "command" | "terminal"; disabled: boolean;
	submit(request: ExecutionRequest): Promise<ChatRun | null>; refresh(): Promise<void>; setError(message: string | null): void;
}) {
	const intl = useIntl();
	const scope = useMemo(() => ({ sessionId: options.sessionId }), [options.sessionId]);
	const live = useRef<typeof scope | null>(scope);
	live.current = scope;
	const latest = useRef(options); latest.current = options;
	const request = useRef<symbol | null>(null);
	const [pending, setPending] = useState<{ scope: typeof scope; value: boolean }>({ scope, value: false });
	useEffect(() => { live.current = scope; request.current = null; return () => { if (live.current === scope) live.current = null; }; }, [scope]);
	const start = async () => {
		const current = latest.current;
		const run = current.run;
		if (live.current !== scope || current.disabled || request.current || !current.model || !run ||
			(run.status !== "preparing" && !deploymentAwaitsResume(run))) return;
		const token = Symbol("deployment execution"); request.current = token;
		setPending({ scope, value: true }); current.setError(null);
		try {
			const result = await current.submit({ message: intl.formatMessage({ id: run.status === "recovering" ? "deploy.plan.resumePrompt" : "deploy.plan.executePrompt" }),
				attachments: [], model: current.model, thinkingLevel: current.thinkingLevel, behavior: "follow_up",
				serverInteractionMode: current.serverInteractionMode, workflow: "deployment_execution", deploymentRunId: run.id });
			if (live.current !== scope || request.current !== token) return;
			if (!result) { current.setError(intl.formatMessage({ id: "deploy.plan.notStarted" })); return; }
			await current.refresh();
		} catch (error) {
			if (live.current === scope && request.current === token) current.setError(error instanceof Error ? error.message : String(error));
		} finally {
			if (live.current === scope && request.current === token) { request.current = null; setPending({ scope, value: false }); }
		}
	};
	return { start, starting: pending.scope === scope && pending.value };
}
