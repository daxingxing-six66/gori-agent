import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { BubblewrapInstallationService } from "../services/bubblewrap-installation-service.ts";

const installParameters = Type.Object({
	packageManager: Type.Union([
		Type.Literal("apt-get"), Type.Literal("dnf"), Type.Literal("yum"), Type.Literal("zypper"), Type.Literal("apk"),
	]),
	useSudo: Type.Boolean({ description: "Use noninteractive sudo when the SSH account is not root" }),
	refreshIndex: Type.Boolean({ description: "Refresh package metadata before installation" }),
});

export const bubblewrapInspectDefinition = {
	name: "bubblewrap_inspect",
	label: "Inspect Bubblewrap installation options",
	description: "When a restricted remote command or Terminal opening reports sandbox_bubblewrap_not_installed, inspect the remote OS, package managers and SSH account without asking for approval. This does not install anything.",
	parameters: Type.Object({}),
};

export const bubblewrapInstallDefinition = {
	name: "bubblewrap_install",
	label: "Install Bubblewrap",
	description: "After bubblewrap_inspect, propose one exact package-manager installation plan. A human must approve installation. The server executes only the approved command outside the sandbox, then automatically probes Bubblewrap. On failure, inspect the reported result and propose a revised plan requiring another approval.",
	parameters: installParameters,
};

export function createBubblewrapInspectionTool(options: {
	sessionId: string;
	installations: BubblewrapInstallationService;
}): AgentTool {
	return {
		...bubblewrapInspectDefinition,
		executionMode: "sequential",
		execute: async (_toolCallId, _params, signal) => ({
			content: [{ type: "text", text: await options.installations.inspect(options.sessionId, signal ?? AbortSignal.timeout(30_000)) }],
			details: {},
		}),
	};
}

export function createBubblewrapInstallTool(options: {
	sessionId: string;
	agentRunId: string;
	installations: BubblewrapInstallationService;
}): AgentTool<typeof installParameters> {
	return {
		...bubblewrapInstallDefinition,
		executionMode: "sequential",
		execute: async (toolCallId, plan, signal) => ({
			content: [{ type: "text", text: await options.installations.install({
				sessionId: options.sessionId, agentRunId: options.agentRunId, toolCallId, plan,
				signal: signal ?? AbortSignal.timeout(600_000),
			}) }],
			details: {},
		}),
	};
}
