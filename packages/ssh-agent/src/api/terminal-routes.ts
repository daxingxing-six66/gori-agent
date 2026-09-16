import { Buffer } from "node:buffer";
import type { TerminalSessionService } from "../application/services/terminal-session-service.ts";
import { TERMINAL_DEFAULTS } from "../application/terminal/terminal-defaults.ts";
import type { TerminalSequencedEvent } from "../application/terminal/terminal-replay-ring.ts";
import { TerminalReplayGapError } from "../application/terminal/terminal-replay-ring.ts";
import type { TerminalEventStreamConnection } from "../application/terminal/terminal-session-actor.ts";
import { ManagementError } from "../domain/errors.ts";
import { effectiveServerInteractionMode } from "../domain/terminal.ts";
import type { BackendLocale } from "../i18n/message.ts";
import { localizePublicValue } from "../i18n/projection.ts";
import { withPublicMessage } from "../i18n/public-error.ts";
import {
	parseCloseTerminal,
	parseCreateTerminalAttachment,
	parseOpenTerminal,
	parseTerminalFocus,
	parseTerminalReady,
	parseTerminalResize,
} from "./terminal-request-validation.ts";

export async function handleTerminalRoute(
	service: TerminalSessionService,
	request: Request,
	url: URL,
	segments: readonly string[],
	locale: BackendLocale = "zh-CN",
): Promise<Response | null> {
	if (segments.length < 4 || segments[1] !== "sessions" || segments[3] !== "terminal") return null;
	const sessionId = segments[2];
	if (segments.length === 4 && request.method === "GET") return json(await service.getStatus(sessionId));
	if (segments.length === 5 && segments[4] === "open" && request.method === "POST") {
		return json(await service.open({ sessionId, ...parseOpenTerminal(await readJson(request)) }), 202);
	}
	if (segments.length === 5 && segments[4] === "close" && request.method === "POST") {
		return json(await service.close({ sessionId, ...parseCloseTerminal(await readJson(request)) }), 202);
	}
	if (segments.length === 5 && segments[4] === "attachments" && request.method === "POST") {
		const input = parseCreateTerminalAttachment(await readJson(request));
		const bootstrap = await service.attach(sessionId, input.requestId);
		return json(
			{
				...bootstrap,
				terminalSessionId: service.getActor(sessionId)?.id,
				status: "bootstrapping",
				owner: false,
				ownershipEpoch: null,
			},
			201,
		);
	}
	if (segments.length === 5 && segments[4] === "timeline" && request.method === "GET") {
		return json({
			events: service.listTimeline(
				sessionId,
				optionalPositiveQuery(url, "before"),
				boundedQuery(url, "limit", 100, 200),
			),
		});
	}
	if (segments.length === 6 && segments[4] === "observations" && request.method === "GET") {
		return json(service.getObservation(sessionId, segments[5]));
	}
	if (segments.length >= 6 && segments[4] === "attachments") {
		const attachmentId = segments[5];
		if (segments.length === 6 && request.method === "DELETE") {
			await service.detach(sessionId, attachmentId);
			return empty();
		}
		if (segments.length === 7 && segments[6] === "ready" && request.method === "POST") {
			const input = parseTerminalReady(await readJson(request));
			await service.ready(sessionId, attachmentId, input.replayedThroughSequence);
			return empty();
		}
		if (segments.length === 7 && segments[6] === "focus" && request.method === "POST") {
			const input = parseTerminalFocus(await readJson(request));
			return json(await service.focus(sessionId, attachmentId, input.focused));
		}
		if (segments.length === 7 && segments[6] === "resize" && request.method === "POST") {
			const input = parseTerminalResize(await readJson(request));
			await service.resize(sessionId, attachmentId, input.ownershipEpoch, {
				rows: input.rows,
				cols: input.cols,
			});
			return empty();
		}
		if (segments.length === 7 && segments[6] === "events" && request.method === "GET") {
			const afterSequence = requiredNonNegativeQuery(url, "afterSequence");
			return new Response(await createTerminalEventStream(service, sessionId, attachmentId, afterSequence, locale), {
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-cache, no-transform",
					connection: "keep-alive",
					"x-accel-buffering": "no",
				},
			});
		}
	}
	return null;
}

async function createTerminalEventStream(
	service: TerminalSessionService,
	sessionId: string,
	attachmentId: string,
	afterSequence: number,
	locale: BackendLocale,
): Promise<ReadableStream<Uint8Array>> {
	const liveEvents: TerminalSequencedEvent[] = [];
	let deliverLive = (event: TerminalSequencedEvent): void => {
		liveEvents.push(event);
	};
	let connection: { readonly terminalSessionId: string; readonly connection: TerminalEventStreamConnection };
	try {
		const connected = await service.connectEvents(sessionId, attachmentId, afterSequence, (event) =>
			deliverLive(event),
		);
		connection = connected;
	} catch (error) {
		if (!(error instanceof TerminalReplayGapError)) throw error;
		return oneShotStream(
			encodeControl(
				service.getActor(sessionId)?.id ?? "unknown",
				"terminal.resync_required",
				{
					requiredAfter: error.requestedAfter,
					oldestAvailable: error.oldestAvailable,
					latest: error.latest,
				},
				locale,
			),
		);
	}
	const encoder = new TextEncoder();
	const heartbeatChunk = encoder.encode(": heartbeat\n\n");
	const chunks = connection.connection.replay.events.map((event) =>
		encodeEvent(connection.terminalSessionId, event, locale),
	);
	chunks.push(
		encodeControl(
			connection.terminalSessionId,
			"terminal.stream.ready",
			{
				replayedThroughSequence: connection.connection.replay.latestSequence ?? afterSequence,
				heartbeatIntervalMs: TERMINAL_DEFAULTS.lifecycle.sseHeartbeatMs,
			},
			locale,
		),
	);
	chunks.push(...liveEvents.map((event) => encodeEvent(connection.terminalSessionId, event, locale)));
	const initialBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
	if (initialBytes > TERMINAL_DEFAULTS.replay.subscriberPendingBytes) {
		connection.connection.disconnect();
		return oneShotStream(
			encodeControl(
				connection.terminalSessionId,
				"terminal.resync_required",
				{
					requiredAfter: afterSequence,
					oldestAvailable: connection.connection.replay.oldestAvailableSequence,
					latest: connection.connection.replay.latestSequence,
				},
				locale,
			),
		);
	}
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let disconnected = false;
	return new ReadableStream<Uint8Array>(
		{
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk);
				const disconnect = (): void => {
					if (disconnected) return;
					disconnected = true;
					if (heartbeat !== undefined) clearInterval(heartbeat);
					connection.connection.disconnect();
				};
				deliverLive = (event) => {
					const chunk = encodeEvent(connection.terminalSessionId, event, locale);
					if (chunk.byteLength > (controller.desiredSize ?? 0)) {
						controller.enqueue(
							encodeControl(
								connection.terminalSessionId,
								"terminal.resync_required",
								{
									requiredAfter: event.sequence - 1,
									oldestAvailable: null,
									latest: event.sequence,
								},
								locale,
							),
						);
						controller.close();
						disconnect();
						return;
					}
					controller.enqueue(chunk);
					if (event.type === "terminal.status" && isTerminal(event.newStatus)) {
						controller.close();
						disconnect();
					}
				};
				heartbeat = setInterval(() => {
					if (!disconnected && heartbeatChunk.byteLength <= (controller.desiredSize ?? 0)) {
						controller.enqueue(heartbeatChunk);
					}
				}, TERMINAL_DEFAULTS.lifecycle.sseHeartbeatMs);
				heartbeat.unref();
			},
			cancel() {
				if (disconnected) return;
				disconnected = true;
				if (heartbeat !== undefined) clearInterval(heartbeat);
				connection.connection.disconnect();
			},
		},
		{
			highWaterMark: TERMINAL_DEFAULTS.replay.subscriberPendingBytes,
			size: (chunk) => chunk.byteLength,
		},
	);
}

function encodeEvent(terminalSessionId: string, event: TerminalSequencedEvent, locale: BackendLocale): Uint8Array {
	let data: unknown;
	if (event.type === "terminal.output") data = { bytesBase64: Buffer.from(event.bytes).toString("base64") };
	else if (event.type === "terminal.resized")
		data = { ...event.geometry, ownerAttachmentId: event.ownerAttachmentId, ownershipEpoch: event.ownershipEpoch };
	else if (event.type === "terminal.resize_owner_changed")
		data = { ownerAttachmentId: event.ownerAttachmentId, ownershipEpoch: event.ownershipEpoch };
	else if (event.type === "terminal.status") {
		data = {
			oldStatus: event.oldStatus,
			newStatus: event.newStatus,
			reason: event.reason,
			effectiveServerInteractionMode: effectiveServerInteractionMode(event.newStatus),
		};
	} else data = event.data;
	return encodeSse(event.type, event.sequence, {
		version: 1,
		terminalSessionId,
		type: event.type,
		sequence: event.sequence,
		emittedAt: new Date(event.emittedAt).toISOString(),
		data: localizePublicValue(data, locale),
	});
}

function encodeControl(terminalSessionId: string, type: string, data: unknown, locale: BackendLocale): Uint8Array {
	return encodeSse(type, null, {
		version: 1,
		terminalSessionId,
		type,
		sequence: null,
		emittedAt: new Date().toISOString(),
		data: localizePublicValue(data, locale),
	});
}

function encodeSse(type: string, sequence: number | null, body: unknown): Uint8Array {
	return new TextEncoder().encode(
		`${sequence === null ? "" : `id: ${sequence}\n`}event: ${type}\ndata: ${JSON.stringify(body)}\n\n`,
	);
}

function oneShotStream(chunk: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(chunk);
			controller.close();
		},
	});
}

function isTerminal(status: string): boolean {
	return status === "closed" || status === "failed" || status === "lost";
}

async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch (error) {
		throw withPublicMessage(
			new ManagementError(
				"validation_error",
				"Request body must contain valid JSON",
				"body",
				error instanceof Error ? error : undefined,
			),
			{ key: "common.request_body_invalid" },
		);
	}
}

function requiredNonNegativeQuery(url: URL, name: string): number {
	const value = url.searchParams.get(name);
	if (value === null || !/^\d+$/.test(value))
		throw new ManagementError("validation_error", `${name} is required`, name);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new ManagementError("validation_error", `${name} is invalid`, name);
	return parsed;
}

function optionalPositiveQuery(url: URL, name: string): number | undefined {
	const value = url.searchParams.get(name);
	if (value === null) return undefined;
	const parsed = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new ManagementError("validation_error", `${name} must be a positive integer`, name);
	}
	return parsed;
}

function boundedQuery(url: URL, name: string, fallback: number, maximum: number): number {
	const value = url.searchParams.get(name);
	if (value === null) return fallback;
	const parsed = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
		throw new ManagementError("validation_error", `${name} must be between 1 and ${maximum}`, name);
	}
	return parsed;
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function empty(): Response {
	return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}
