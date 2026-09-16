import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	progressToolUpdate,
	statusToolUpdate,
	textToolUpdate,
	toToolExecutionUpdateEvent,
} from "../src/application/tool-update-protocol.ts";

describe("Tool update transport protocol", () => {
	it("projects a declared progress update without exposing args or raw AgentToolResult fields", () => {
		const event = toolUpdateEvent({
			content: [{ type: "text", text: "internal progress text" }],
			details: {
				privatePath: "/private/source.bin",
				update: {
					type: "progress",
					detail: {
						current: 512,
						total: 1_024,
						unit: "bytes",
						message: "Uploading source.bin",
						privateValue: "not transported",
					},
				},
			},
		});

		expect(toToolExecutionUpdateEvent(event)).toEqual({
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "example_tool",
			update: progressToolUpdate({
				current: 512,
				total: 1_024,
				unit: "bytes",
				message: "Uploading source.bin",
			}),
		});
	});

	it("supports standardized text and status updates", () => {
		expect(
			toToolExecutionUpdateEvent(
				toolUpdateEvent({ content: [], details: { update: textToolUpdate("current output") } }),
			),
		).toMatchObject({ update: { type: "text", detail: { content: "current output", mode: "replace" } } });
		expect(
			toToolExecutionUpdateEvent(
				toolUpdateEvent({ content: [], details: { update: statusToolUpdate("preparing", "Checking input") } }),
			),
		).toMatchObject({ update: { type: "status", detail: { status: "preparing", message: "Checking input" } } });
	});

	it("falls back to a replace-text snapshot for Tools without a declared update", () => {
		const event = toolUpdateEvent({
			content: [
				{ type: "text", text: "stdout" },
				{ type: "image", data: "not transported", mimeType: "image/png" },
				{ type: "text", text: "stderr" },
			],
			details: { truncation: { truncated: false } },
		});

		expect(toToolExecutionUpdateEvent(event)).toMatchObject({
			update: { type: "text", detail: { content: "stdout\nstderr", mode: "replace" } },
		});
	});

	it("ignores an update with neither a valid declaration nor text content", () => {
		const event = toolUpdateEvent({
			content: [],
			details: { update: { type: "progress", detail: { current: 2, total: 1, unit: "bytes" } } },
		});
		expect(toToolExecutionUpdateEvent(event)).toBeUndefined();
	});
});

function toolUpdateEvent(partialResult: unknown): Extract<AgentEvent, { type: "tool_execution_update" }> {
	return {
		type: "tool_execution_update",
		toolCallId: "call-1",
		toolName: "example_tool",
		args: { secret: "not transported" },
		partialResult,
	};
}
