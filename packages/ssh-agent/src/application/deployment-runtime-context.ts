import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { DeploymentModeView } from "../domain/deployment-session.ts";
import { modelVisibleMessages } from "./deployment-history-message.ts";

export function deploymentStateInstructions(mode: DeploymentModeView | null): string {
	return `<deployment-state>\n${JSON.stringify(mode ? {
		deploymentMode: true, deploymentId: mode.deployment.id, phase: mode.phase,
		stage: mode.stage, stageStatus: mode.stageStatus, nextStage: mode.nextStage,
	} : { deploymentMode: false })}\n</deployment-state>`;
}

/** Add current trusted facts at projection time, without growing the stored transcript. */
export function deploymentProviderMessages(messages: AgentMessage[], mode: DeploymentModeView | null): AgentMessage[] {
	const visible = modelVisibleMessages(messages);
	if (!mode) return visible;
	let lastAssistant = -1;
	for (let index = visible.length - 1; index >= 0; index--) {
		if (visible[index]?.role === "assistant") { lastAssistant = index; break; }
	}
	return visible.map((message, index) => message.role === "toolResult" && index > lastAssistant ? {
		...message, content: [...message.content, { type: "text" as const, text: deploymentStateInstructions(mode) }],
	} : message);
}
