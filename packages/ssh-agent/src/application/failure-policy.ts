import { AttachmentError } from "../domain/attachment.ts";
import type { ChatRun } from "../domain/chat.ts";
import { ChatError } from "../domain/chat.ts";
import { ChatCompactionError } from "../domain/context-compaction.ts";
import { ManagementError } from "../domain/errors.ts";
import { FileTransferError } from "../domain/file-transfer.ts";
import { LocalFileSystemError } from "../domain/local-file-system.ts";
import { SshAgentError } from "../domain/ssh-failure.ts";
import { TerminalError } from "../domain/terminal.ts";
import { enUSMessages } from "../i18n/catalogs/en-US.ts";
import {
	type BackendMessageDescriptor,
	type BackendMessageKey,
	backendMessage,
	formatBackendMessage,
	parseBackendMessageDescriptor,
} from "../i18n/message.ts";
import type { FailureScope } from "./failure-reporter.ts";
import { failureIdentity, reportFailure } from "./failure-reporter.ts";
import {
	isUnsupportedSelectedModel,
	type ProviderFailureMessage,
	providerFailureDescriptor,
} from "./provider-failure-classification.ts";

export interface PublicErrorDescriptor {
	readonly code: string;
	readonly status: number;
	readonly message: BackendMessageDescriptor;
	readonly field?: string;
	readonly retryable?: boolean;
	readonly details?: Record<string, unknown>;
	readonly cause?: unknown;
}

interface PublicMessageCarrier {
	readonly publicMessage: BackendMessageDescriptor;
}

export class HttpBoundaryError extends Error implements PublicMessageCarrier {
	readonly code: string;
	readonly status: number;
	readonly publicMessage: BackendMessageDescriptor;

	constructor(code: string, status: number, publicMessage: BackendMessageDescriptor) {
		super(formatBackendMessage("en-US", publicMessage));
		this.name = "HttpBoundaryError";
		this.code = code;
		this.status = status;
		this.publicMessage = publicMessage;
	}
}

export function withPublicMessage<T extends Error>(
	error: T,
	message: BackendMessageDescriptor,
): T & PublicMessageCarrier {
	return Object.assign(error, { publicMessage: message });
}

const CODE_MESSAGES: Readonly<Record<string, BackendMessageKey>> = {
	validation_error: "common.validation_error",
	not_found: "common.not_found",
	revision_conflict: "common.revision_conflict",
	llm_provider_conflict: "management.llm_provider_conflict",
	llm_provider_in_use: "management.llm_provider_in_use",
	active_credential_in_use: "management.active_credential_in_use",
	workspace_has_sessions: "management.workspace_has_sessions",
	session_has_active_operations: "management.session_has_active_operations",
	session_has_active_chat_run: "management.session_has_active_chat_run",
	session_has_active_attachment_upload: "management.session_has_active_attachment_upload",
	session_deletion_in_progress: "management.session_deletion_in_progress",
	session_work_dir_unavailable: "management.session_work_dir_unavailable",
	host_key_mismatch: "management.host_key_mismatch",
	connection_failed: "management.connection_failed",
	authentication_failed: "management.authentication_failed",
	secret_store_failed: "management.secret_store_failed",
	chat_session_not_found: "chat.session_not_found",
	chat_session_busy: "chat.session_busy",
	chat_run_not_found: "chat.run_not_found",
	chat_run_not_active: "chat.run_not_active",
	chat_system_messages_unsupported: "chat.system_messages_unsupported",
	chat_prompt_not_initialized: "chat.prompt_not_initialized",
	chat_model_not_found: "chat.model_not_found",
	chat_model_not_supported: "chat.model_not_supported",
	chat_model_selection_invalid: "chat.model_selection_invalid",
	chat_model_selection_required: "chat.model_selection_required",
	chat_thinking_level_unsupported: "chat.thinking_level_unsupported",
	chat_provider_not_configured: "chat.provider_not_configured",
	chat_message_invalid: "chat.message_invalid",
	chat_attachment_ids_invalid: "chat.attachment_ids_invalid",
	chat_attachment_limit_exceeded: "chat.attachment_limit_exceeded",
	chat_attachment_not_found: "chat.attachment_not_found",
	chat_attachment_image_format_unsupported: "chat.attachment_image_format_unsupported",
	chat_attachment_content_invalid: "chat.attachment_content_invalid",
	chat_attachment_changed: "chat.attachment_changed",
	chat_attachment_storage_unavailable: "chat.attachment_storage_unavailable",
	chat_model_image_input_unsupported: "chat.model_image_input_unsupported",
	chat_run_failed: "chat.run_failed",
	chat_provider_request_rejected: "provider.request_rejected",
	chat_approval_persistence_failed: "chat.approval_persistence_failed",
	chat_credential_check_failed: "chat.credential_check_failed",
	chat_persistence_failed: "chat.persistence_failed",
	chat_run_interrupted: "chat.run_interrupted",
	approval_not_found: "chat.approval_not_found",
	approval_already_resolved: "chat.approval_already_resolved",
	chat_queue_item_not_found: "chat.queue_item_not_found",
	chat_context_overflow: "chat.context_overflow",
	chat_context_no_compactable_history: "chat.context_no_compactable_history",
	chat_context_compaction_insufficient: "chat.context_compaction_insufficient",
	chat_context_compaction_failed: "chat.context_compaction_failed",
	chat_compaction_model_unavailable: "chat.compaction_model_unavailable",
	file_already_exists: "sftp.file_already_exists",
	file_not_found: "sftp.file_not_found",
	not_a_directory: "sftp.not_a_directory",
	cannot_download_directory: "sftp.cannot_download_directory",
	cannot_delete_directory: "sftp.cannot_delete_directory",
	unsupported_file_type: "sftp.unsupported_file_type",
	atomic_overwrite_unsupported: "sftp.atomic_overwrite_unsupported",
	transfer_not_found: "sftp.transfer_not_found",
	transfer_direction_mismatch: "sftp.transfer_direction_mismatch",
	transfer_invalid_state: "sftp.transfer_invalid_state",
	transfer_size_mismatch: "sftp.transfer_size_mismatch",
	transfer_cancelled: "sftp.transfer_cancelled",
	transfer_queue_full: "sftp.transfer_queue_full",
	transfer_interrupted: "sftp.transfer_interrupted",
	transfer_result_uncertain: "sftp.transfer_result_uncertain",
	sftp_permission_denied: "sftp.permission_denied",
	sftp_operation_failed: "sftp.operation_failed",
	local_file_path_invalid: "local_file.path_invalid",
	local_file_path_outside_work_dir: "local_file.path_outside_work_dir",
	local_file_path_not_found: "local_file.path_not_found",
	local_file_path_not_directory: "local_file.path_not_directory",
	local_file_path_symlink_not_allowed: "local_file.symlink_not_allowed",
	local_file_access_denied: "local_file.access_denied",
	local_file_system_unavailable: "local_file.system_unavailable",
	terminal_session_not_found: "terminal.session_not_found",
	terminal_session_unavailable: "terminal.session_unavailable",
	terminal_session_already_active: "terminal.session_already_active",
	terminal_capacity_exceeded: "terminal.capacity_exceeded",
	terminal_transition_in_progress: "terminal.transition_in_progress",
	server_interaction_mode_conflict: "terminal.mode_conflict",
	terminal_open_timeout: "terminal.open_timeout",
	terminal_initialization_failed: "terminal.initialization_failed",
	terminal_open_failed: "terminal.open_failed",
	terminal_persistence_failed: "terminal.persistence_failed",
	terminal_attachment_capacity_exceeded: "terminal.attachment_capacity_exceeded",
	terminal_attachment_not_live: "terminal.attachment_not_live",
	terminal_resync_required: "terminal.resync_required",
	terminal_resize_not_owner: "terminal.resize_not_owner",
	terminal_ownership_epoch_mismatch: "terminal.ownership_epoch_mismatch",
	terminal_resize_invalid: "terminal.resize_invalid",
	terminal_interaction_busy: "terminal.interaction_busy",
	terminal_interaction_not_prepared: "terminal.interaction_not_prepared",
	terminal_approval_required: "terminal.approval_required",
	terminal_input_invalid: "terminal.input_invalid",
	terminal_input_too_large: "terminal.input_too_large",
	terminal_observation_not_found: "terminal.observation_not_found",
	terminal_operation_failed: "terminal.operation_failed",
	attachment_not_found: "attachment.not_found",
	attachment_name_invalid: "attachment.name_invalid",
	attachment_mime_type_invalid: "attachment.mime_type_invalid",
	attachment_too_large: "attachment.too_large",
	attachment_size_mismatch: "attachment.size_mismatch",
	attachment_upload_cancelled: "attachment.upload_cancelled",
	attachment_content_cancelled: "attachment.content_cancelled",
	attachment_image_format_unsupported: "attachment.image_format_unsupported",
	attachment_content_invalid: "attachment.content_invalid",
	attachment_changed: "attachment.changed",
	attachment_storage_unavailable: "attachment.storage_unavailable",
};

export function descriptorForPublicCode(code: string, field?: string): BackendMessageDescriptor | undefined {
	if (code === "validation_error" && field !== undefined) return backendMessage("common.validation_field", { field });
	if (code === "guard_blocked") return undefined;
	const key = sshMessageKey(code) ?? CODE_MESSAGES[code];
	if (key === undefined) return undefined;
	return backendMessage(key);
}

export function descriptorForPublicFailure(code: string, message: string): BackendMessageDescriptor | undefined {
	return code === "guard_blocked"
		? backendMessage("ssh.guard_blocked_with_reason", { reason: message })
		: descriptorForPublicCode(code);
}

export function normalizePublicError(error: unknown): PublicErrorDescriptor {
	if (error instanceof HttpBoundaryError) return known(error.code, error.status, error);
	if (error instanceof TerminalError) {
		return known(
			error.code,
			error.status,
			error,
			{
				retryable: error.retryable,
				...(Object.keys(error.details).length === 0 ? {} : { details: { ...error.details } }),
			},
			descriptorForPublicFailure(error.code, error.message),
		);
	}
	if (error instanceof ChatError) return known(error.code, error.status, error);
	if (error instanceof AttachmentError) {
		return known(error.code, error.status, error, {
			...(error.field === undefined ? {} : { field: error.field }),
		});
	}
	if (error instanceof ChatCompactionError) {
		return known(error.code, error.status, error, { retryable: error.retryable });
	}
	if (error instanceof FileTransferError) {
		return known(error.code, error.status, error, {
			...(error.details === undefined ? {} : { details: safePublicDetails(error.details) }),
		});
	}
	if (error instanceof LocalFileSystemError) {
		return known(
			error.code,
			error.status,
			error,
			{},
			error.code === "session_not_found" ? backendMessage("local_file.session_not_found") : undefined,
		);
	}
	if (error instanceof SshAgentError) {
		const failure = error.failure;
		return known(
			failure.code,
			sshStatus(failure.category),
			error,
			{
				retryable: failure.retryable,
				...(failure.safeDetails === undefined ? {} : { details: failure.safeDetails }),
			},
			descriptorForPublicFailure(failure.code, failure.message),
		);
	}
	if (error instanceof ManagementError) {
		return known(error.code, managementStatus(error.code), error, {
			...(error.field === undefined ? {} : { field: error.field }),
		});
	}
	const { errorId } = failureIdentity(error);
	return {
		code: "internal_error",
		status: 500,
		message: backendMessage("common.internal_error"),
		details: { errorId },
		cause: error,
	};
}

/** The Run and HTTP boundaries share the same domain classification and presentation. */
export function runFailure(error: unknown, scope: FailureScope): NonNullable<ChatRun["failure"]> {
	const normalized = normalizePublicError(error);
	const { errorId } = reportFailure(error, scope);
	return {
		schemaVersion: 1,
		action: normalized.retryable
			? "retry_later"
			: normalized.code === "internal_error"
				? "contact_support"
				: "check_request",
		errorId,
		stage: scope.stage,
		code: normalized.code,
		message: formatBackendMessage("en-US", normalized.message),
		messageKey: normalized.message.key,
		messageValues: normalized.message.values,
		retryable: normalized.retryable ?? false,
	};
}

export function assistantFailure(
	message: ProviderFailureMessage,
	selection?: { providerId: string; modelId: string },
): NonNullable<ChatRun["failure"]> {
	if (message.failure) return message.failure;
	if (
		isUnsupportedSelectedModel(
			message,
			selection?.providerId ?? message.provider,
			selection?.modelId ?? message.model,
		)
	) {
		const descriptor = message.providerFailure
			? providerFailureDescriptor(message.providerFailure, "removed")
			: backendMessage("chat.model_not_supported");
		return {
			schemaVersion: 1,
			action: message.providerFailure?.retryable ? "retry_later" : "check_request",
			errorId: failureIdentity(message).errorId,
			code: "chat_model_not_supported",
			stage: "provider_request",
			message: formatBackendMessage("en-US", descriptor),
			messageKey: descriptor.key,
			messageValues: descriptor.values,
			retryable: false,
		};
	}
	const attachmentCode = message.diagnostics?.find((entry) => entry.type === "ssh_agent_attachment_input_failure")
		?.details?.code;
	const code =
		typeof attachmentCode === "string"
			? attachmentCode
			: ((
					{
						context_overflow: "chat_context_overflow",
						context_compaction_insufficient: "chat_context_compaction_insufficient",
						context_compaction_failed: "chat_context_compaction_failed",
						compaction_model_unavailable: "chat_compaction_model_unavailable",
					} as Record<string, string>
				)[message.errorCode ?? ""] ??
				(message.providerFailure ? "chat_provider_request_rejected" : "chat_run_failed"));
	const descriptor =
		message.errorMessageDescriptor ?? descriptorForPublicCode(code) ?? backendMessage("chat.run_failed");
	return {
		schemaVersion: 1,
		action: message.providerFailure?.retryable ? "retry_later" : "check_request",
		errorId: failureIdentity(message).errorId,
		code,
		stage: message.providerFailure ? "provider_request" : "agent",
		message: formatBackendMessage("en-US", descriptor),
		messageKey: descriptor.key,
		messageValues: descriptor.values,
		retryable: message.providerFailure?.retryable ?? false,
		...(message.providerFailure?.upstreamStatus ? { upstreamStatus: message.providerFailure.upstreamStatus } : {}),
	};
}

function safePublicDetails(details: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(details)) {
		const safe = safePublicValue(value);
		if (safe !== undefined) result[key] = safe;
	}
	return result;
}

function safePublicValue(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) return value.map(safePublicValue).filter((entry) => entry !== undefined);
	if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
		return safePublicDetails(value as Record<string, unknown>);
	}
	return undefined;
}

function known(
	code: string,
	status: number,
	cause: unknown,
	options: Omit<PublicErrorDescriptor, "code" | "status" | "message" | "cause"> = {},
	message?: BackendMessageDescriptor,
): PublicErrorDescriptor {
	return {
		code,
		status,
		message:
			message ??
			publicMessageFrom(cause) ??
			descriptorForPublicCode(code, options.field) ??
			backendMessage("common.internal_error"),
		...options,
		cause,
	};
}

function publicMessageFrom(value: unknown): BackendMessageDescriptor | undefined {
	if (value === null || typeof value !== "object" || !("publicMessage" in value)) return undefined;
	return parseBackendMessageDescriptor((value as { publicMessage?: unknown }).publicMessage);
}

function sshMessageKey(code: string): BackendMessageKey | undefined {
	const key = `ssh.${code}` as BackendMessageKey;
	return key in enUSMessages ? key : undefined;
}

function sshStatus(category: string): number {
	return category === "authentication" ? 401 : category === "request" ? 400 : 502;
}

function managementStatus(code: ManagementError["code"]): number {
	switch (code) {
		case "validation_error":
			return 400;
		case "not_found":
			return 404;
		case "authentication_failed":
			return 401;
		case "revision_conflict":
		case "llm_provider_conflict":
		case "llm_provider_in_use":
		case "active_credential_in_use":
		case "workspace_has_sessions":
		case "session_has_active_operations":
		case "session_has_active_chat_run":
		case "session_has_active_attachment_upload":
		case "session_work_dir_unavailable":
		case "session_deletion_in_progress":
		case "host_key_mismatch":
			return 409;
		case "connection_failed":
			return 502;
		case "secret_store_failed":
			return 500;
	}
}
