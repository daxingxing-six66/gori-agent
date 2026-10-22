import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalApi } from "../features/terminal/api/terminal-api.ts";
import {
	parseTerminalEnvelope,
	requireTerminalAttachment,
	requireTerminalObservation,
	requireTerminalOwnership,
	requireTerminalStatus,
	requireTerminalTimeline,
	terminalSandboxFromTimelineEvent,
} from "../features/terminal/model/terminal.ts";
import { TerminalEventStream } from "../features/terminal/runtime/terminal-event-stream.ts";
import { shouldRetryTerminalConnection } from "../features/terminal/model/terminal-retry.ts";
import { ApiError } from "../shared/errors/api-error.ts";

afterEach(() => vi.unstubAllGlobals());

const terminal = {
	id: "terminal-1",
	sessionId: "session-1",
	workspaceId: "workspace-1",
	status: "active",
	requestedSandboxMode: "workspace_write",
	sandbox: { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 8, launcherVersion: "2", sandboxRoot: "/srv/test" },
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
			inputControl: { mode: "idle", attachmentId: null, agentRunId: null, epoch: 0 },
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
	it("accepts Bubblewrap Terminal facts and rejects mixed backend fields", () => {
		const bubblewrap = { mode: "workspace_write", backend: "bubblewrap", enforcement: "full",
			bubblewrapVersion: "0.12.0", sandboxRoot: "/srv/test" };
		const response = { terminal: { ...terminal, sandbox: bubblewrap },
			effectiveServerInteractionMode: "terminal", transitionInProgress: false,
			capabilities: { minRows: 12, maxRows: 120, minCols: 40, maxCols: 320 } };
		expect(requireTerminalStatus(response).terminal?.sandbox).toEqual(bubblewrap);
		expect(() => requireTerminalStatus({ ...response, terminal: { ...terminal,
			sandbox: { ...bubblewrap, abi: 5 } } })).toThrow();
	});

	it("rejects malformed state instead of trusting server JSON", () => {
		const fallback = { mode: "full_access", backend: "none", enforcement: "none", source: "landlock_unavailable", detectedAt: 10 };
		expect(requireTerminalStatus({ terminal: { ...terminal, sandbox: fallback }, effectiveServerInteractionMode: "terminal", transitionInProgress: false, capabilities: { minRows: 12, maxRows: 120, minCols: 40, maxCols: 320 } }).terminal?.sandbox).toEqual(fallback);
		const currentFallback = { ...fallback, source: "sandbox_unavailable" };
		expect(requireTerminalStatus({ terminal: { ...terminal, sandbox: currentFallback }, effectiveServerInteractionMode: "terminal", transitionInProgress: false, capabilities: { minRows: 12, maxRows: 120, minCols: 40, maxCols: 320 } }).terminal?.sandbox).toEqual(currentFallback);
		expect(() => requireTerminalStatus({ terminal: { ...terminal, sandbox: { mode: "workspace_write", backend: "landlock", enforcement: "full", abi: 5, launcherVersion: "3", sandboxRoot: "/srv/../etc" } }, effectiveServerInteractionMode: "terminal", transitionInProgress: false, capabilities: { minRows: 12, maxRows: 120, minCols: 40, maxCols: 320 } })).toThrow();
		expect(() => requireTerminalStatus({ terminal: { ...terminal, sandbox: { ...fallback, detectedAt: -1 } }, effectiveServerInteractionMode: "terminal", transitionInProgress: false, capabilities: { minRows: 12, maxRows: 120, minCols: 40, maxCols: 320 } })).toThrow();
		expect(() => requireTerminalStatus({ terminal: { ...terminal, sandbox: { mode: "full_access", backend: "none", enforcement: "none", approvedAt: 1 } }, effectiveServerInteractionMode: "terminal", transitionInProgress: false, capabilities: { minRows: 12, maxRows: 120, minCols: 40, maxCols: 320 } })).toThrow();
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

	it("validates and exposes actual sandbox facts in active timeline events", () => {
		const event = { id: "event-2", terminalSessionId: "terminal-1", sessionId: "session-1", timelineSequence: 2,
			terminalEventSequence: 0, type: "terminal.active", interactionId: null, observationId: null, agentRunId: null,
			data: { sandbox: terminal.sandbox }, createdAt: 2 };
		expect(terminalSandboxFromTimelineEvent(requireTerminalTimeline({ events: [event] })[0]!)).toEqual(terminal.sandbox);
		expect(() => requireTerminalTimeline({ events: [{ ...event, data: { sandbox: { mode: "workspace_write", abi: "8" } } }] })).toThrow();
	});
});

describe("Terminal API client", () => {
	it("preserves a non-retryable missing Terminal Session error and stops automatic attachment retry", async () => {
		const fetchMock = mockResponse({
			error: { code: "terminal_session_not_found", message: "未找到 Terminal Session", retryable: false },
		}, 404);
		const request = terminalApi.attach("session-1", "request-1");
		await expect(request).rejects.toMatchObject({
			status: 404,
			code: "terminal_session_not_found",
			retryable: false,
		});
		const error = await request.catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(ApiError);
		expect(shouldRetryTerminalConnection(error)).toBe(false);
		expect(shouldRetryTerminalConnection(new ApiError(503, "terminal_unavailable", "Busy", undefined, undefined, true))).toBe(true);
		expect(shouldRetryTerminalConnection(new TypeError("Network failure"))).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("passes cancellation to an in-flight attachment request", async () => {
		const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
			init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
		}));
		vi.stubGlobal("fetch", fetchMock);
		const controller = new AbortController();
		const request = terminalApi.attach("session-1", "request-1", controller.signal);
		controller.abort();
		await expect(request).rejects.toMatchObject({ name: "AbortError" });
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(init.signal).toBe(controller.signal);
	});

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

		expect(sources[0]?.url).toBe("http://127.0.0.1:3002/api/sessions/session-1/terminal/attachments/attachment-1/events?afterSequence=4&locale=en-US");
		sources[0]?.dispatchEvent(new Event("error"));
		expect(onError).toHaveBeenCalledOnce();
		stream.close();
	});
});
