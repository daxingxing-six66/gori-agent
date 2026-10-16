import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { DeploymentModeView } from "../domain/deployment-session.ts";
import { modelVisibleMessages } from "./deployment-history-message.ts";

export function deploymentStateInstructions(mode: DeploymentModeView | null): string {
	return `<deployment-state>\n${JSON.stringify(mode ? {
		deploymentMode: true, deploymentId: mode.deployment.id, phase: mode.phase,
		stage: mode.stage, stageStatus: mode.stageStatus, nextStage: mode.nextStage,
		selection: mode.selection,
	} : { deploymentMode: false })}\n</deployment-state>`;
}

/** Project trusted state as system context after the complete tool-result group, never inside tool output. */
export function deploymentProviderMessages(messages: AgentMessage[], mode: DeploymentModeView | null): AgentMessage[] {
	const visible = modelVisibleMessages(messages);
	if (!mode) return visible;
	let lastAssistant = -1;
	for (let index = visible.length - 1; index >= 0; index--) {
		if (visible[index]?.role === "assistant") { lastAssistant = index; break; }
	}
	if (!visible.some((message, index) => message.role === "toolResult" && index > lastAssistant)) return visible;
	return [...visible, { role: "system", content: [{ type: "text", text: deploymentStateInstructions(mode) }],
		timestamp: visible.at(-1)?.timestamp ?? mode.deployment.createdAt }];
}
