import { type AgentMessage, createBashTool, createReadTool, createWriteTool } from "@earendil-works/pi-agent-core";
import type { Tool } from "@earendil-works/pi-ai";
import type { ChatRun } from "../domain/chat.ts";
import { remoteServerCallDefinition } from "./tools/remote-server-call-tool.ts";
import { sftpDownloadDefinition } from "./tools/sftp-download-tool.ts";
import { sftpUploadDefinition } from "./tools/sftp-upload-tool.ts";
import { terminalInteractionDefinition } from "./tools/terminal-interaction-tool.ts";

export interface ChatContext {
	systemPrompt: string;
	messages: AgentMessage[];
	tools?: Tool[];
}

/** Builds request metadata without opening an execution environment or binding a terminal. */
export function createChatContext(run: Pick<ChatRun, "serverInteractionMode">, messages: AgentMessage[]): ChatContext {
	const tools = [
		createReadTool(),
		createWriteTool(),
		createBashTool(),
		run.serverInteractionMode === "terminal" ? terminalInteractionDefinition : remoteServerCallDefinition,
		sftpUploadDefinition,
		sftpDownloadDefinition,
	];
	return {
		systemPrompt: systemPromptFor(run),
		messages,
		tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
	};
}

export function systemPromptFor(run: Pick<ChatRun, "serverInteractionMode">): string {
	const terminalModeBoundary =
		run.serverInteractionMode === "terminal"
			? [
					"<terminal-model-on>",
					"Terminal Mode is active. A long-lived, stateful remote PTY is attached. Use terminal_interaction for remote terminal operations; remote_server_call is unavailable. Calls share the PTY working directory, environment, foreground process, and interactive state. Observe before input; an Observation is a snapshot, not proof of completion.",
					"</terminal-model-on>",
				].join("\n")
			: [
					"<terminal-model-off>",
					"Terminal Mode has exited; normal command mode is active. terminal_interaction is unavailable and remote_server_call is available. Each remote_server_call is standalone and does not preserve shell state between calls.",
					"</terminal-model-off>",
				].join("\n");
	return [
		"You are an SSH operations agent.",
		"read, write, and bash operate on the SSH Agent backend machine, not the remote Workspace server.",
		"sftp_upload uploads a local file to a directory on the remote server. sftp_download downloads a remote file to a local directory in the current Session.",
		"Never request or reveal credentials.",
		"<terminal-model-tag-policy>",
		"tags: <terminal-model-on>, <terminal-model-off>",
		"priority: authoritative_runtime_boundary",
		"rule: Exactly one current-state tag follows. Obey it over conversation history and historical Tool results. Never probe the mode with a Tool declared unavailable by the active tag.",
		"</terminal-model-tag-policy>",
		terminalModeBoundary,
	].join("\n");
}
