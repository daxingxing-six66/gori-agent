import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalApi } from "../features/terminal/api/terminal-api.ts";
import {
	parseTerminalEnvelope,
	requireTerminalAttachment,
	requireTerminalObservation,
	requireTerminalOwnership,
	requireTerminalStatus,
	requireTerminalTimeline,
} from "../features/terminal/model/terminal.ts";
import { TerminalEventStream } from "../features/terminal/runtime/terminal-event-stream.ts";

afterEach(() => vi.unstubAllGlobals());

const terminal = {
	id: "terminal-1",
	sessionId: "session-1",
	workspaceId: "workspace-1",
	status: "active",
	geometry: { rows: 36, cols: 120 },
	eventSequence: 4,
	ownershipEpoch: 2,
	closeReason: null,
	failureCode: null,
	failureMessage: null,
	createdAt: 1,
	updatedAt: 2,
};

function mockResponse(body: unknown, status = 200): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(() =>
		Promise.resolve(status === 204 ? new Response(null, { status }) : Response.json(body, { status })),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

describe("Terminal response validation", () => {
	it("accepts complete status, attachment, ownership, timeline, and SSE envelopes", () => {
		expect(requireTerminalStatus({
			terminal,
			effectiveServerInteractionMode: "terminal",
			transitionInProgress: false,
			capabilities: { minRows: 12, maxRows: 120, minCols: 40, maxCols: 320 },
		}).terminal).toEqual(terminal);
		expect(requireTerminalAttachment({
			attachmentId: "attachment-1",
			terminalSessionId: "terminal-1",
			status: "bootstrapping",
			snapshot: {
				format: "xterm-ansi",
				formatVersion: 1,
				encoding: "base64",
				data: "",
				sequence: 4,
				rows: 36,
				cols: 120,
			},
			owner: false,
			ownershipEpoch: null,
		}).attachmentId).toBe("attachment-1");
		expect(requireTerminalOwnership({ owner: true, ownershipEpoch: 3 })).toEqual({
			owner: true,
			ownershipEpoch: 3,
		});
		expect(requireTerminalTimeline({
			events: [{
				id: "event-1",
				terminalSessionId: "terminal-1",
				sessionId: "session-1",
				timelineSequence: 1,
				terminalEventSequence: 4,
				type: "observation.processing",
				interactionId: "interaction-1",
				observationId: "observation-1",
				agentRunId: "run-1",
				data: {},
				createdAt: 2,
			}],
		})).toHaveLength(1);
		expect(requireTerminalObservation({
			id: "observation-1",
			terminalSessionId: "terminal-1",
			startSequence: 4,
			endSequence: 8,
			kind: "transcript",
			agentViewText: "memory output",
			capturedAt: 2,
		}).endSequence).toBe(8);
		expect(parseTerminalEnvelope({
			version: 1,
			terminalSessionId: "terminal-1",
			type: "terminal.output",
			sequence: 5,
			emittedAt: "2026-08-28T00:00:00.000Z",
			data: { bytesBase64: "b2s=" },
		}, "terminal.output")).not.toBeNull();
	});

	it("rejects malformed state instead of trusting server JSON", () => {
		expect(() => requireTerminalOwnership({ owner: true, ownershipEpoch: null })).toThrow();
		expect(() => requireTerminalStatus({
			terminal,
			effectiveServerInteractionMode: "terminal",
			transitionInProgress: false,
			capabilities: { minRows: 120, maxRows: 12, minCols: 40, maxCols: 320 },
		})).toThrow();
		expect(() => requireTerminalAttachment({
			attachmentId: "attachment-1",
			terminalSessionId: "terminal-1",
			status: "bootstrapping",
			snapshot: {
				format: "xterm-ansi",
				formatVersion: 1,
				encoding: "base64",
				data: "",
				sequence: -1,
				rows: 36,
				cols: 120,
			},
			owner: false,
			ownershipEpoch: null,
		})).toThrow();
		expect(() => requireTerminalTimeline({
			events: [{ ...terminal, timelineSequence: 1, terminalEventSequence: -1, type: "terminal.active" }],
		})).toThrow();
		expect(() => requireTerminalObservation({
			id: "observation-1",
			terminalSessionId: "terminal-1",
			startSequence: 8,
			endSequence: 4,
			kind: "transcript",
			agentViewText: "",
			capturedAt: 2,
		})).toThrow();
		expect(parseTerminalEnvelope({
			version: 1,
			terminalSessionId: "terminal-1",
			type: "terminal.output",
			sequence: -1,
			emittedAt: "invalid",
			data: {},
		}, "terminal.output")).toBeNull();
		expect(parseTerminalEnvelope({
			version: 1,
			terminalSessionId: "terminal-1",
			type: "terminal.output",
			sequence: 1,
			emittedAt: "not-a-timestamp",
			data: {},
		}, "terminal.output")).toBeNull();
	});
});

describe("Terminal API client", () => {
	it("sends explicit request IDs and owner-scoped resize fields", async () => {
		let fetchMock = mockResponse(terminal, 202);
		await terminalApi.open("session / 1", "request-1");
		let init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(init.body))).toEqual({ requestId: "request-1" });

		fetchMock = mockResponse(undefined, 204);
		await terminalApi.resize("session / 1", "attachment / 1", 7, 42, 132);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"/api/sessions/session%20%2F%201/terminal/attachments/attachment%20%2F%201/resize",
		);
		init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(init.body))).toEqual({ ownershipEpoch: 7, rows: 42, cols: 132 });
	});

	it("loads and validates an Observation through the existing endpoint", async () => {
		const fetchMock = mockResponse({
			id: "observation-1",
			terminalSessionId: "terminal-1",
			startSequence: 4,
			endSequence: 8,
			kind: "screen",
			agentViewText: "screen",
			capturedAt: 2,
		});
		await expect(terminalApi.getObservation("session / 1", "observation / 1")).resolves.toMatchObject({
			id: "observation-1",
			kind: "screen",
		});
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"/api/sessions/session%20%2F%201/terminal/observations/observation%20%2F%201",
		);
	});
});

describe("Terminal event stream", () => {
	it("reports EventSource failures so the panel can refresh and bootstrap a new attachment", () => {
		const sources: FakeEventSource[] = [];
		class FakeEventSource extends EventTarget {
			constructor(readonly url: string) {
				super();
				sources.push(this);
			}

			close(): void {}
		}
		vi.stubGlobal("EventSource", FakeEventSource);
		const onError = vi.fn();
		const stream = new TerminalEventStream("session-1", "attachment-1", 4, "en-US", onError);

		expect(sources[0]?.url).toBe("/api/sessions/session-1/terminal/attachments/attachment-1/events?afterSequence=4&locale=en-US");
		sources[0]?.dispatchEvent(new Event("error"));
		expect(onError).toHaveBeenCalledOnce();
		stream.close();
	});
});
