import type { BackendLocale, BackendMessageDescriptor } from "./message.ts";
import { formatBackendMessage, parseBackendMessageDescriptor } from "./message.ts";
import { descriptorForPublicCode } from "./public-error.ts";

export function localizePublicValue(value: unknown, locale: BackendLocale): unknown {
	return project(value, locale, new WeakMap<object, unknown>());
}

function project(
	value: unknown,
	locale: BackendLocale,
	seen: WeakMap<object, unknown>,
	containerField?: string,
): unknown {
	if (value === null || typeof value !== "object") return value;
	if (value instanceof Uint8Array || value instanceof ArrayBuffer) return value;
	const cached = seen.get(value);
	if (cached !== undefined) return cached;
	if (Array.isArray(value)) {
		const result: unknown[] = [];
		seen.set(value, result);
		for (const entry of value) result.push(project(entry, locale, seen, containerField));
		return result;
	}
	const record = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	seen.set(value, result);
	for (const [key, entry] of Object.entries(record)) {
		if (isInternalMessageMetadataKey(key)) continue;
		result[key] =
			key === "failure" && isRecord(entry) && entry.schemaVersion === 1
				? projectChatFailure(entry, locale)
				: project(entry, locale, seen, key);
	}
	applyMessage(result, record, "message", descriptorFrom(record, "message"), locale);
	const assistantFailureDescriptor =
		record.role === "assistant" && record.stopReason === "error"
			? descriptorForPublicCode(
					record.errorCode === "context_overflow" ? "chat_context_overflow" : "chat_run_failed",
				)
			: undefined;
	applyMessage(
		result,
		record,
		"errorMessage",
		(isRecord(record.failure) ? descriptorFrom(record.failure, "message") : undefined) ??
			descriptorFrom(record, "errorMessage") ??
			assistantFailureDescriptor,
		locale,
	);
	if (assistantFailureDescriptor !== undefined) delete result.diagnostics;
	applyMessage(result, record, "description", descriptorFrom(record, "description"), locale);
	applyMessage(result, record, "failureMessage", descriptorFrom(record, "failureMessage"), locale);
	const failureDescriptor = descriptorFromFailure(record, containerField);
	if (failureDescriptor !== undefined && typeof record.message === "string") {
		result.message = formatBackendMessage(locale, failureDescriptor);
	}
	const details = isRecord(record.details) ? record.details : undefined;
	const presentation =
		parseBackendMessageDescriptor(record.presentationMessage) ??
		parseBackendMessageDescriptor(details?.presentationMessage);
	if (presentation !== undefined && Array.isArray(record.content)) {
		const suffix = typeof details?.presentationContentSuffix === "string" ? details.presentationContentSuffix : "";
		result.content = [{ type: "text", text: `${formatBackendMessage(locale, presentation)}${suffix}` }];
	}
	return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function applyMessage(
	result: Record<string, unknown>,
	record: Record<string, unknown>,
	field: "message" | "errorMessage" | "description" | "failureMessage",
	descriptor: BackendMessageDescriptor | undefined,
	locale: BackendLocale,
): void {
	if (
		descriptor !== undefined &&
		(typeof record[field] === "string" ||
			record[field] === null ||
			(field === "errorMessage" && record.stopReason === "error"))
	) {
		result[field] = formatBackendMessage(locale, descriptor);
	}
}

function descriptorFrom(record: Record<string, unknown>, field: string): BackendMessageDescriptor | undefined {
	const direct = parseBackendMessageDescriptor(record[`${field}Descriptor`]);
	if (direct !== undefined) return direct;
	const key = record[`${field}Key`] ?? (field === "description" ? record.descriptionMessageKey : undefined);
	if (typeof key !== "string") {
		return field === "failureMessage" && typeof record.failureCode === "string"
			? descriptorForPublicCode(record.failureCode)
			: undefined;
	}
	return parseBackendMessageDescriptor({
		key,
		values: record[`${field}Values`] ?? (field === "description" ? record.descriptionValues : undefined),
	});
}

function descriptorFromFailure(
	record: Record<string, unknown>,
	containerField: string | undefined,
): BackendMessageDescriptor | undefined {
	const persisted = parseBackendMessageDescriptor({ key: record.messageKey, values: record.messageValues });
	if (persisted !== undefined) return persisted;
	return (containerField === "error" || containerField === "failure" || containerField === "lastError") &&
		typeof record.code === "string"
		? descriptorForPublicCode(record.code)
		: undefined;
}

function isInternalMessageMetadataKey(key: string): boolean {
	return (
		key === "providerFailure" ||
		key === "messageDescriptor" ||
		key === "errorMessageDescriptor" ||
		key === "descriptionDescriptor" ||
		key === "failureMessageDescriptor" ||
		key === "presentationMessage" ||
		key === "presentationContentSuffix" ||
		key === "messageKey" ||
		key === "messageValues" ||
		key === "descriptionMessageKey" ||
		key === "descriptionValues" ||
		key === "failureMessageKey" ||
		key === "failureMessageValues"
	);
}

function projectChatFailure(record: Record<string, unknown>, locale: BackendLocale): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key of [
		"schemaVersion",
		"errorId",
		"stage",
		"code",
		"message",
		"retryable",
		"action",
		"upstreamStatus",
	]) {
		const value = record[key];
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") result[key] = value;
	}
	const descriptor = descriptorFrom(record, "message");
	if (descriptor) result.message = formatBackendMessage(locale, descriptor);
	if (isRecord(record.recovery)) {
		const recovery = record.recovery;
		const message = descriptorFrom(recovery, "message");
		result.recovery = {
			errorId: recovery.errorId,
			code: recovery.code,
			message: message ? formatBackendMessage(locale, message) : recovery.message,
		};
	}
	return result;
}
