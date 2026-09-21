import type { ConnectionTestService } from "../application/services/connection-test-service.ts";
import { reportFailure } from "../application/failure-reporter.ts";
import type { SshAgentManagementApi } from "../application/management-api.ts";
import type { AttachmentService } from "../application/services/attachment-service.ts";
import type { ChatService } from "../application/services/chat-service.ts";
import type { FileTransferService } from "../application/services/file-transfer-service.ts";
import type { LocalFileSystemService } from "../application/services/local-file-system-service.ts";
import type { TerminalSessionService } from "../application/services/terminal-session-service.ts";
import type { SshConnectionPoolControl } from "../application/ssh-channel-broker.ts";
import type { WorkspaceEventHub, WorkspaceEventTopic } from "../application/workspace-event-hub.ts";
import type { ChatMessageListCursor, ChatQueueItemStatus } from "../domain/chat.ts";
import { ManagementError } from "../domain/errors.ts";
import { type CreateFileTransferInput, FileTransferError } from "../domain/file-transfer.ts";
import { type BackendLocale, formatBackendMessage, resolveBackendLocale } from "../i18n/message.ts";
import { localizePublicValue } from "../i18n/projection.ts";
import { normalizePublicError, withPublicMessage } from "../i18n/public-error.ts";
import { chatMessageListResponse } from "./attachment-projection.ts";
import { handleAttachmentRoute } from "./attachment-routes.ts";
import {
	parseActivateCredential,
	parseConfigureLlmProviderApiKey,
	parseCreateChatRun,
	parseCreateCredential,
	parseCreateCustomLlmProvider,
	parseCreateSession,
	parseCreateWorkspace,
	parseTestWorkspaceConnection,
	parseEnqueueChatMessage,
	parseGuardRulePackImport,
	parseGuardUpdate,
	parseUpdateWorkspace,
	parseUpdateContextCompactionSettings,
	parseUpdateCustomLlmProvider,
	parseUpdateSession,
} from "./request-validation.ts";
import { handleTerminalRoute } from "./terminal-routes.ts";

export type SshAgentHttpHandler = (request: Request) => Promise<Response>;

export function createSshAgentHttpHandler(options: {
	api: SshAgentManagementApi;
	transfers: FileTransferService;
	events: WorkspaceEventHub;
	broker: Pick<SshConnectionPoolControl, "snapshotWorkspace">;
	chat: ChatService;
	localFiles: LocalFileSystemService;
	terminals: TerminalSessionService;
	attachments: AttachmentService;
	connectionTests: ConnectionTestService;
}): SshAgentHttpHandler {
	return async (request) => {
		const url = new URL(request.url);
		const requestedLocale =
			request.method === "GET" && url.pathname.endsWith("/events") ? url.searchParams.get("locale") : null;
		const locale = resolveBackendLocale({
			locale: requestedLocale,
			acceptLanguage: request.headers.get("accept-language"),
		});
		const variesByLanguage = !requestedLocale?.trim();
		try {
			return await localizeResponse(await route(options, request, locale), locale, variesByLanguage);
		} catch (error) {
			return errorResponse(error, locale, variesByLanguage);
		}
	};
}

async function route(
	options: {
		api: SshAgentManagementApi;
		transfers: FileTransferService;
		events: WorkspaceEventHub;
		broker: Pick<SshConnectionPoolControl, "snapshotWorkspace">;
		chat: ChatService;
		localFiles: LocalFileSystemService;
		terminals: TerminalSessionService;
		attachments: AttachmentService;
		connectionTests: ConnectionTestService;
	},
	request: Request,
	locale: BackendLocale,
): Promise<Response> {
	const { api } = options;
	const url = new URL(request.url);
	const segments = url.pathname
		.split("/")
		.filter((segment) => segment.length > 0)
		.map((segment) => decodeURIComponent(segment));
	if (segments[0] !== "api") return notFound();
	const attachmentResponse = await handleAttachmentRoute(options.attachments, request, url, segments);
	if (attachmentResponse !== null) return attachmentResponse;
	if (matches(segments, ["api", "settings", "compaction"])) {
		if (request.method === "GET") return json(api.getContextCompactionSettings());
		if (request.method === "PUT") {
			return json(
				api.updateContextCompactionSettings({
					...parseUpdateContextCompactionSettings(await readJson(request)),
					expectedRevision: expectedRevision(url),
				}),
			);
		}
	}
	const terminalResponse = await handleTerminalRoute(options.terminals, request, url, segments, locale);
	if (terminalResponse !== null) return terminalResponse;
	if (matches(segments, ["api", "local-files"]) && request.method === "GET") {
		return json(await options.localFiles.listSystemDirectory(url.searchParams.get("path") ?? undefined));
	}

	if (segments.length === 4 && segments[1] === "sessions" && segments[3] === "local-files") {
		if (request.method === "GET") {
			return json(await options.localFiles.listDirectory(segments[2], url.searchParams.get("path") ?? undefined));
		}
	}

	if (segments.length >= 4 && segments[1] === "sessions" && segments[3] === "chat") {
		const sessionId = segments[2];
		if (segments.length === 5 && segments[4] === "context-usage" && request.method === "GET") {
			return json({ contextUsage: await options.chat.getContextUsage(sessionId) });
		}
		if (segments.length === 5 && segments[4] === "runs" && request.method === "POST") {
			return json(await options.chat.createRun({ sessionId, ...parseCreateChatRun(await readJson(request)) }), 201);
		}
		if (segments.length === 6 && segments[4] === "runs" && segments[5] === "active" && request.method === "GET") {
			return json({ run: await options.chat.getActiveRun(sessionId) });
		}
		if (segments.length === 5 && segments[4] === "messages" && request.method === "GET") {
			const response = options.chat.listMessages(sessionId, chatMessageCursor(url), boundedLimit(url, 100));
			return json(chatMessageListResponse(response));
		}
		if (segments.length === 5 && segments[4] === "compactions" && request.method === "POST") {
			return json(await options.chat.compactSession(sessionId, request.signal));
		}
		if (segments.length === 5 && segments[4] === "approvals" && request.method === "GET") {
			return json({ approvals: options.chat.listApprovals(sessionId, url.searchParams.get("status") ?? "pending") });
		}
		if (segments.length === 7 && segments[4] === "approvals" && request.method === "POST") {
			const action = segments[6];
			if (action === "approve" || action === "reject")
				return json(options.chat.resolveApproval(sessionId, segments[5], action === "approve"));
		}
		if (segments.length >= 7 && segments[4] === "runs") {
			const runId = segments[5];
			if (segments.length === 7 && segments[6] === "events" && request.method === "GET") {
				const last = request.headers.get("last-event-id");
				return new Response(
					options.chat.subscribe(sessionId, runId, last === null ? undefined : Number(last), locale),
					{
						headers: {
							"content-type": "text/event-stream",
							"cache-control": "no-cache, no-transform",
							connection: "keep-alive",
							"x-accel-buffering": "no",
						},
					},
				);
			}
			if (segments.length === 7 && segments[6] === "cancel" && request.method === "POST")
				return json(await options.chat.cancelRun(sessionId, runId));
			if (segments.length === 7 && segments[6] === "queue") {
				if (request.method === "GET")
					return json({ items: options.chat.listQueue(sessionId, runId, chatQueueStatus(url)) });
				if (request.method === "POST")
					return json(
						await options.chat.enqueue(sessionId, runId, parseEnqueueChatMessage(await readJson(request))),
						201,
					);
			}
			if (segments.length === 9 && segments[6] === "queue" && segments[8] === "steer" && request.method === "POST") {
				return json(options.chat.promoteQueued(sessionId, runId, segments[7]));
			}
			if (segments.length === 8 && segments[6] === "queue" && request.method === "DELETE") {
				options.chat.cancelQueued(sessionId, runId, segments[7]);
				return empty();
			}
		}
	}

	if (segments.length >= 4 && segments[1] === "workspaces" && segments[3] === "sftp") {
		const workspaceId = segments[2];
		if (segments.length === 5 && segments[4] === "entries" && request.method === "GET") {
			const path = url.searchParams.get("path") ?? undefined;
			return json(await options.transfers.listDirectory(workspaceId, path));
		}
		if (segments.length === 5 && segments[4] === "file" && request.method === "DELETE") {
			const path = requiredPath(url);
			await options.transfers.deleteFile(workspaceId, path);
			return empty();
		}
		if (segments.length === 5 && segments[4] === "transfers") {
			if (request.method === "GET") return json(await options.transfers.list(workspaceId, transferLimit(url)));
			if (request.method === "POST")
				return json(await options.transfers.create(workspaceId, parseTransfer(await readJson(request))), 201);
		}
		if (segments.length === 7 && segments[4] === "transfers") {
			const transferId = segments[5];
			if (segments[6] === "cancel" && request.method === "POST")
				return json(await options.transfers.cancel(workspaceId, transferId));
			if (segments[6] === "content" && request.method === "PUT") {
				if (request.body === null)
					throw new FileTransferError("transfer_size_mismatch", "Upload request body is required", 400);
				const transfer = await options.transfers.get(workspaceId, transferId);
				const contentLength = Number(request.headers.get("content-length"));
				if (!Number.isSafeInteger(contentLength) || contentLength !== transfer.totalBytes)
					throw new FileTransferError(
						"transfer_size_mismatch",
						"Content-Length does not match the declared file size",
						400,
					);
				return json(
					await options.transfers.upload(workspaceId, transferId, requestBody(request.body), request.signal),
				);
			}
			if (segments[6] === "content" && request.method === "GET") {
				const transfer = await options.transfers.get(workspaceId, transferId);
				if (transfer.direction !== "download")
					throw new FileTransferError(
						"transfer_direction_mismatch",
						"Transfer direction does not match this endpoint",
						409,
					);
				if (transfer.status !== "pending")
					throw new FileTransferError("transfer_invalid_state", "Transfer is not pending", 409);
				const controller = new AbortController();
				const body = new ReadableStream<Uint8Array>({
					start(streamController) {
						void options.transfers
							.download(workspaceId, transferId, controller.signal, async (chunk) =>
								streamController.enqueue(chunk),
							)
							.then(
								() => streamController.close(),
								(error) => streamController.error(error),
							);
					},
					cancel: (reason) => controller.abort(reason),
				});
				return new Response(body, {
					headers: {
						"content-type": "application/octet-stream",
						"content-length": String(transfer.totalBytes),
						"content-disposition": contentDisposition(transfer.fileName),
						"cache-control": "no-store",
					},
				});
			}
		}
	}

	if (segments.length === 4 && segments[1] === "workspaces" && segments[3] === "events" && request.method === "GET") {
		const workspaceId = segments[2];
		const topics = parseTopics(url);
		const body = options.events.subscribe(workspaceId, topics, locale);
		queueMicrotask(() => {
			if (topics.has("connection"))
				options.events.publish(workspaceId, {
					type: "connection.snapshot",
					data: options.broker.snapshotWorkspace(workspaceId),
				});
			if (topics.has("transfers"))
				void options.transfers
					.list(workspaceId, 100)
					.then(({ transfers }) => {
						for (const transfer of transfers)
							if (transfer.status === "pending" || transfer.status === "running")
								options.events.publish(workspaceId, { type: "transfer.updated", data: transfer });
					})
					.catch(() => {});
		});
		return new Response(body, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
				"x-accel-buffering": "no",
			},
		});
	}

	if (request.method === "GET" && matches(segments, ["api", "workspace-session-tree"])) {
		return json(await api.getWorkspaceSessionTree());
	}

	if (request.method === "GET" && matches(segments, ["api", "llm", "providers"])) {
		return json(await api.listLlmProviders());
	}
	if (matches(segments, ["api", "llm", "custom-providers"])) {
		if (request.method === "GET") return json({ providers: await api.listCustomLlmProviders() });
		if (request.method === "POST") {
			return json(await api.createCustomLlmProvider(parseCreateCustomLlmProvider(await readJson(request))), 201);
		}
	}
	if (segments.length === 4 && segments[1] === "llm" && segments[2] === "custom-providers") {
		const providerId = segments[3];
		if (request.method === "GET") return json(await api.getCustomLlmProvider(providerId));
		if (request.method === "PUT") {
			return json(
				await api.updateCustomLlmProvider(parseUpdateCustomLlmProvider(providerId, await readJson(request))),
			);
		}
		if (request.method === "DELETE") {
			await api.deleteCustomLlmProvider({ providerId, expectedRevision: expectedRevision(url) });
			return empty();
		}
	}
	if (request.method === "GET" && matches(segments, ["api", "llm", "provider-credentials"])) {
		return json(await api.listLlmProviderCredentials());
	}
	if (segments.length === 5 && segments[1] === "llm" && segments[2] === "providers") {
		const providerId = segments[3];
		if (segments[4] === "models" && request.method === "GET") {
			return json(await api.listLlmProviderModels(providerId));
		}
		if (segments[4] === "credential") {
			if (request.method === "GET") return json(await api.getLlmProviderCredential(providerId));
			if (request.method === "PUT") {
				return json(
					await api.configureLlmProviderApiKey(
						parseConfigureLlmProviderApiKey(providerId, await readJson(request)),
					),
				);
			}
			if (request.method === "DELETE") {
				await api.deleteLlmProviderCredential({ providerId, expectedRevision: expectedRevision(url) });
				return empty();
			}
		}
	}

	if (matches(segments, ["api", "workspaces", "test-connection"]) && request.method === "POST") {
		return json(await options.connectionTests.test(parseTestWorkspaceConnection(await readJson(request)), request.signal));
	}
	if (matches(segments, ["api", "workspaces"]) && request.method === "POST") {
		return json(await api.createWorkspace(parseCreateWorkspace(await readJson(request))), 201);
	}
	if (segments.length === 3 && segments[1] === "workspaces") {
		const workspaceId = segments[2];
		if (request.method === "PATCH") {
			const input = parseUpdateWorkspace(await readJson(request));
			return json(await api.updateWorkspace({ id: workspaceId, ...input }));
		}
		if (request.method === "DELETE") {
			await api.deleteWorkspace({ id: workspaceId, expectedRevision: expectedRevision(url) });
			return empty();
		}
	}
	if (segments.length === 4 && segments[1] === "workspaces") {
		const workspaceId = segments[2];
		if (segments[3] === "credentials") {
			if (request.method === "GET") return json(await api.listWorkspaceCredentials(workspaceId));
			if (request.method === "POST") {
				return json(await api.createCredential(workspaceId, parseCreateCredential(await readJson(request))), 201);
			}
		}
		if (segments[3] === "active-credential") {
			if (request.method === "GET") return json(await api.getActiveWorkspaceCredential(workspaceId));
			if (request.method === "PUT") {
				const input = parseActivateCredential(await readJson(request));
				return json(await api.activateWorkspaceCredential({ workspaceId, ...input }));
			}
		}
		if (segments[3] === "guard") {
			if (request.method === "GET") return json(await api.getWorkspaceGuard(workspaceId));
			if (request.method === "PATCH") {
				const input = parseGuardUpdate(await readJson(request));
				return json(await api.updateWorkspaceGuard({ workspaceId, ...input }));
			}
		}
		if (segments[3] === "sessions" && request.method === "POST") {
			const input = parseCreateSession(await readJson(request));
			return json(await api.createSession({ workspaceId, ...input }), 201);
		}
	}
	if (segments.length >= 5 && segments[1] === "workspaces" && segments[3] === "guard") {
		const workspaceId = segments[2];
		if (segments.length === 5 && segments[4] === "rule-packs" && request.method === "GET") {
			return json(await api.listWorkspaceGuardRulePacks(workspaceId));
		}
		if (
			segments.length === 6 &&
			segments[4] === "rule-packs" &&
			segments[5] === "import" &&
			request.method === "POST"
		) {
			return json(
				await api.importWorkspaceGuardRulePacks({
					workspaceId,
					...parseGuardRulePackImport(await readJson(request)),
				}),
			);
		}
	}
	if (segments.length === 5 && segments[1] === "workspaces" && segments[3] === "credentials") {
		const workspaceId = segments[2];
		const credentialId = segments[4];
		if (request.method === "GET") return json(await api.getCredential(workspaceId, credentialId));
		if (request.method === "DELETE") {
			await api.deleteCredential({
				workspaceId,
				id: credentialId,
				expectedRevision: expectedRevision(url),
			});
			return empty();
		}
	}

	if (segments.length === 3 && segments[1] === "sessions") {
		const sessionId = segments[2];
		if (request.method === "GET")
			return json({
				...(await api.getSession(sessionId)),
				chatModelSelection: options.chat.getLatestModelSelection(sessionId),
			});
		if (request.method === "PATCH") {
			const input = parseUpdateSession(await readJson(request));
			return json(await api.renameSession({ id: sessionId, ...input }));
		}
		if (request.method === "DELETE") {
			await api.deleteSession({ id: sessionId, expectedRevision: expectedRevision(url) });
			return empty();
		}
	}

	return notFound();
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

function expectedRevision(url: URL): number {
	const value = url.searchParams.get("expectedRevision");
	const revision = value === null ? Number.NaN : Number(value);
	if (value === null || !/^\d+$/.test(value) || !Number.isSafeInteger(revision) || revision <= 0) {
		throw new ManagementError(
			"validation_error",
			"expectedRevision query parameter must be a positive integer",
			"expectedRevision",
		);
	}
	return revision;
}

function nonNegativeInteger(url: URL, name: string, fallback: number): number {
	return optionalNonNegativeInteger(url, name) ?? fallback;
}

function optionalNonNegativeInteger(url: URL, name: string): number | undefined {
	const value = url.searchParams.get(name);
	if (value === null) return undefined;
	const parsed = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed))
		throw new ManagementError("validation_error", `${name} must be a non-negative integer`, name);
	return parsed;
}

function chatMessageCursor(url: URL): ChatMessageListCursor {
	const beforeSequence = optionalNonNegativeInteger(url, "beforeSequence");
	const afterSequence = optionalNonNegativeInteger(url, "afterSequence");
	if (beforeSequence !== undefined && afterSequence !== undefined) {
		throw new ManagementError(
			"validation_error",
			"beforeSequence and afterSequence cannot be used together",
			"beforeSequence",
		);
	}
	if (beforeSequence !== undefined) return { direction: "before", sequence: beforeSequence };
	if (afterSequence !== undefined) return { direction: "after", sequence: afterSequence };
	return { direction: "latest" };
}

function boundedLimit(url: URL, fallback: number): number {
	const value = nonNegativeInteger(url, "limit", fallback);
	if (value < 1 || value > 100)
		throw new ManagementError("validation_error", "limit must be between 1 and 100", "limit");
	return value;
}

function chatQueueStatus(url: URL): ChatQueueItemStatus {
	const status = url.searchParams.get("status") ?? "pending";
	if (status === "pending" || status === "consumed" || status === "cancelled") return status;
	throw new ManagementError("validation_error", "status must be pending, consumed, or cancelled", "status");
}

function matches(actual: string[], expected: string[]): boolean {
	return actual.length === expected.length && actual.every((segment, index) => segment === expected[index]);
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
	return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

function empty(): Response {
	return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

function notFound(): Response {
	return json(
		{ error: { code: "not_found", message: "API endpoint not found", messageKey: "common.api_not_found" } },
		404,
	);
}

function errorResponse(error: unknown, locale: BackendLocale, variesByLanguage: boolean): Response {
	if (error === null || typeof error !== "object") error = new Error(String(error));
	const normalized = normalizePublicError(error);
	const { errorId } = reportFailure(error, { stage: "http" });
	return json(
		{
			error: {
				errorId,
				code: normalized.code,
				message: formatBackendMessage(locale, normalized.message),
				...(normalized.field === undefined ? {} : { field: normalized.field }),
				...(normalized.retryable === undefined ? {} : { retryable: normalized.retryable }),
				...(normalized.details === undefined ? {} : { details: normalized.details }),
			},
		},
		normalized.status,
		languageHeaders(locale, variesByLanguage),
	);
}

function parseTransfer(value: unknown): CreateFileTransferInput {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new ManagementError("validation_error", "body must be an object", "body");
	const body = value as Record<string, unknown>;
	if (body.direction === "upload") {
		if (
			typeof body.remotePath !== "string" ||
			typeof body.totalBytes !== "number" ||
			!Number.isSafeInteger(body.totalBytes) ||
			body.totalBytes < 0
		)
			throw new ManagementError(
				"validation_error",
				"upload requires remotePath and a non-negative integer totalBytes",
				"body",
			);
		if (body.overwrite !== undefined && typeof body.overwrite !== "boolean")
			throw new ManagementError("validation_error", "overwrite must be a boolean", "overwrite");
		return {
			direction: "upload",
			remotePath: body.remotePath,
			totalBytes: body.totalBytes,
			...(body.overwrite === undefined ? {} : { overwrite: body.overwrite }),
		};
	}
	if (body.direction === "download" && typeof body.remotePath === "string")
		return { direction: "download", remotePath: body.remotePath };
	throw new ManagementError("validation_error", "direction must be upload or download", "direction");
}

async function* requestBody(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
	const reader = body.getReader();
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) return;
			yield result.value;
		}
	} finally {
		reader.releaseLock();
	}
}

function requiredPath(url: URL): string {
	const path = url.searchParams.get("path");
	if (!path) throw new ManagementError("validation_error", "path query parameter is required", "path");
	return path;
}
function transferLimit(url: URL): number {
	const value = url.searchParams.get("limit");
	if (value === null) return 50;
	const limit = Number(value);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
		throw new ManagementError("validation_error", "limit must be between 1 and 100", "limit");
	return limit;
}
function parseTopics(url: URL): ReadonlySet<WorkspaceEventTopic> {
	const allowed = new Set<WorkspaceEventTopic>(["monitoring", "connection", "transfers", "sessions"]);
	const values = (url.searchParams.get("topics") ?? "monitoring,connection,transfers").split(",");
	const topics = new Set<WorkspaceEventTopic>();
	for (const value of values) {
		if (!allowed.has(value as WorkspaceEventTopic))
			throw new ManagementError("validation_error", "topics contains an unsupported value", "topics");
		topics.add(value as WorkspaceEventTopic);
	}
	return topics;
}
function contentDisposition(fileName: string): string {
	return `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

async function localizeResponse(
	response: Response,
	locale: BackendLocale,
	variesByLanguage: boolean,
): Promise<Response> {
	const headers = new Headers(response.headers);
	headers.set("content-language", locale);
	if (variesByLanguage) appendVary(headers, "Accept-Language");
	if (!response.headers.get("content-type")?.includes("application/json")) {
		return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
	}
	return Response.json(localizePublicValue(await response.json(), locale), {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function appendVary(headers: Headers, value: string): void {
	const values = (headers.get("vary") ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (!values.some((entry) => entry.toLowerCase() === value.toLowerCase())) values.push(value);
	headers.set("vary", values.join(", "));
}

function languageHeaders(locale: BackendLocale, variesByLanguage: boolean): Record<string, string> {
	return {
		"content-language": locale,
		...(variesByLanguage ? { vary: "Accept-Language" } : {}),
	};
}
