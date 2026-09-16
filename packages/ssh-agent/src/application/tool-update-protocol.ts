import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { BackendMessageDescriptor } from "../i18n/message.ts";
import { parseBackendMessageDescriptor } from "../i18n/message.ts";

export type ToolUpdateTextMode = "replace";
export type ToolUpdateProgressUnit = "bytes" | "items";
export type ToolUpdateStatus = "preparing" | "waiting_for_approval" | "running";

export type ToolUpdate =
	| {
			type: "text";
			detail: {
				content: string;
				mode: ToolUpdateTextMode;
			};
	  }
	| {
			type: "progress";
			detail: {
				current: number;
				total: number;
				unit: ToolUpdateProgressUnit;
				message?: string;
				messageDescriptor?: BackendMessageDescriptor;
			};
	  }
	| {
			type: "status";
			detail: {
				status: ToolUpdateStatus;
				message: string;
				messageDescriptor?: BackendMessageDescriptor;
			};
	  };

export interface ToolUpdateDetails {
	/** Reserved transport hint. Tool-specific detail fields may coexist beside it. */
	update?: ToolUpdate;
	/** Browser-only presentation hint. Agent Context continues to use canonical content. */
	presentationMessage?: BackendMessageDescriptor;
	/** Canonical dynamic suffix retained after a localized presentation message. */
	presentationContentSuffix?: string;
}

export interface ToolExecutionUpdateEventData {
	type: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	update: ToolUpdate;
}

type AgentToolExecutionUpdateEvent = Extract<AgentEvent, { type: "tool_execution_update" }>;

export function textToolUpdate(content: string): ToolUpdate {
	return { type: "text", detail: { content, mode: "replace" } };
}

export function progressToolUpdate(input: {
	current: number;
	total: number;
	unit: ToolUpdateProgressUnit;
	message?: string;
	messageDescriptor?: BackendMessageDescriptor;
}): ToolUpdate {
	return {
		type: "progress",
		detail: {
			current: input.current,
			total: input.total,
			unit: input.unit,
			...(input.message === undefined ? {} : { message: input.message }),
			...(input.messageDescriptor === undefined ? {} : { messageDescriptor: input.messageDescriptor }),
		},
	};
}

export function statusToolUpdate(
	status: ToolUpdateStatus,
	message: string,
	messageDescriptor?: BackendMessageDescriptor,
): ToolUpdate {
	return {
		type: "status",
		detail: { status, message, ...(messageDescriptor === undefined ? {} : { messageDescriptor }) },
	};
}

export function toToolExecutionUpdateEvent(
	event: AgentToolExecutionUpdateEvent,
): ToolExecutionUpdateEventData | undefined {
	const update = readDeclaredUpdate(event.partialResult) ?? textFallback(event.partialResult);
	if (update === undefined) return undefined;
	return {
		type: "tool_execution_update",
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		update,
	};
}

function readDeclaredUpdate(partialResult: unknown): ToolUpdate | undefined {
	if (!isRecord(partialResult) || !isRecord(partialResult.details)) return undefined;
	return parseToolUpdate(partialResult.details.update);
}

function parseToolUpdate(value: unknown): ToolUpdate | undefined {
	if (!isRecord(value) || !isRecord(value.detail)) return undefined;
	if (value.type === "text") {
		if (typeof value.detail.content !== "string" || value.detail.mode !== "replace") return undefined;
		return textToolUpdate(value.detail.content);
	}
	if (value.type === "progress") {
		const { current, total, unit, message } = value.detail;
		const messageDescriptor = parseBackendMessageDescriptor(value.detail.messageDescriptor);
		if (
			typeof current !== "number" ||
			!Number.isFinite(current) ||
			current < 0 ||
			typeof total !== "number" ||
			!Number.isFinite(total) ||
			total < 0 ||
			current > total ||
			(unit !== "bytes" && unit !== "items") ||
			(message !== undefined && typeof message !== "string")
		)
			return undefined;
		return progressToolUpdate({
			current,
			total,
			unit,
			...(message === undefined ? {} : { message }),
			...(messageDescriptor === undefined ? {} : { messageDescriptor }),
		});
	}
	if (value.type === "status") {
		const { status, message } = value.detail;
		if (
			(status !== "preparing" && status !== "waiting_for_approval" && status !== "running") ||
			typeof message !== "string"
		)
			return undefined;
		return statusToolUpdate(status, message, parseBackendMessageDescriptor(value.detail.messageDescriptor));
	}
	return undefined;
}

function textFallback(partialResult: unknown): ToolUpdate | undefined {
	if (!isRecord(partialResult) || !Array.isArray(partialResult.content)) return undefined;
	const content = partialResult.content
		.filter(
			(item): item is { type: "text"; text: string } =>
				isRecord(item) && item.type === "text" && typeof item.text === "string",
		)
		.map((item) => item.text)
		.join("\n");
	return content.length === 0 ? undefined : textToolUpdate(content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
