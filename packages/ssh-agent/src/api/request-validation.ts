import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { ChatError, type ChatQueueBehavior } from "../domain/chat.ts";
import { MAX_CHAT_IMAGE_ATTACHMENTS } from "../domain/chat-attachment.ts";
import type { ChatCompactionModelSelection } from "../domain/context-compaction.ts";
import type { CreateCredentialInput, CredentialSecret } from "../domain/credential.ts";
import { ManagementError } from "../domain/errors.ts";
import type { CommandGuardMatch, UpdateCommandGuardRuleInput, UpdateGuardInput } from "../domain/guard.ts";
import {
	type ConfigureLlmProviderApiKeyInput,
	type CreateCustomLlmProviderInput,
	CUSTOM_LLM_PROVIDER_APIS,
	type CustomLlmModelInput,
	type CustomLlmProviderApi,
	type CustomLlmProviderCompat,
	type UpdateCustomLlmProviderInput,
} from "../domain/llm-provider.ts";
import type { CreateWorkspaceInput, WorkspaceEnvironment } from "../domain/workspace.ts";

type JsonObject = Record<string, unknown>;

export function parseUpdateContextCompactionSettings(value: unknown): {
	triggerPercent: number;
	model: ChatCompactionModelSelection | null;
} {
	const body = object(value, "body");
	exactKeys(body, ["triggerPercent", "model"]);
	const triggerPercent = number(body, "triggerPercent");
	let model: ChatCompactionModelSelection | null = null;
	if (body.model !== null) {
		const source = object(body.model, "model");
		exactKeys(source, ["providerId", "modelId"], "model");
		model = {
			providerId: string(source, "providerId", "model.providerId"),
			modelId: string(source, "modelId", "model.modelId"),
		};
	}
	return { triggerPercent, model };
}

export function parseCreateCustomLlmProvider(value: unknown): CreateCustomLlmProviderInput {
	const body = object(value, "body");
	exactKeys(body, ["id", "name", "baseUrl", "api", "authMode", "compat", "models", "credential"]);
	return {
		id: string(body, "id"),
		...parseCustomLlmProviderBody(body),
		...(body.credential === undefined ? {} : { credential: parseCustomLlmProviderCredential(body.credential) }),
	};
}

export function parseUpdateCustomLlmProvider(providerId: string, value: unknown): UpdateCustomLlmProviderInput {
	const body = object(value, "body");
	exactKeys(body, ["name", "baseUrl", "api", "authMode", "compat", "models", "expectedRevision"]);
	return {
		providerId,
		...parseCustomLlmProviderBody(body),
		expectedRevision: requiredPositiveInteger(body, "expectedRevision"),
	};
}

function parseCustomLlmProviderBody(body: JsonObject): Omit<CreateCustomLlmProviderInput, "credential" | "id"> {
	const api = string(body, "api");
	if (!CUSTOM_LLM_PROVIDER_APIS.includes(api as CustomLlmProviderApi)) invalid("api is not supported", "api");
	const authMode = string(body, "authMode");
	if (authMode !== "api_key" && authMode !== "none") invalid("authMode must be api_key or none", "authMode");
	if (!Array.isArray(body.models)) invalid("models must be an array", "models");
	return {
		name: string(body, "name"),
		baseUrl: string(body, "baseUrl"),
		api: api as CustomLlmProviderApi,
		authMode,
		...(body.compat === undefined ? {} : { compat: parseCustomLlmCompat(body.compat) }),
		models: body.models.map(parseCustomLlmModel),
	};
}

function parseCustomLlmProviderCredential(value: unknown): NonNullable<CreateCustomLlmProviderInput["credential"]> {
	const credential = object(value, "credential");
	exactKeys(credential, ["type", "apiKey"], "credential");
	const type = string(credential, "type", "credential.type");
	if (type !== "api_key") invalid("credential.type must be api_key", "credential.type");
	return { type, apiKey: string(credential, "apiKey", "credential.apiKey") };
}

function parseCustomLlmCompat(value: unknown): CustomLlmProviderCompat {
	const compat = object(value, "compat");
	exactKeys(
		compat,
		[
			"supportsDeveloperRole",
			"supportsReasoningEffort",
			"supportsUsageInStreaming",
			"maxTokensField",
			"supportsStrictMode",
			"supportsTemperature",
			"supportsStrictTools",
			"forceAdaptiveThinking",
		],
		"compat",
	);
	const result: CustomLlmProviderCompat = {};
	for (const key of [
		"supportsDeveloperRole",
		"supportsReasoningEffort",
		"supportsUsageInStreaming",
		"supportsStrictMode",
		"supportsTemperature",
		"supportsStrictTools",
		"forceAdaptiveThinking",
	] as const) {
		const entry = compat[key];
		if (entry !== undefined && typeof entry !== "boolean") invalid(`${key} must be a boolean`, `compat.${key}`);
		if (entry !== undefined) result[key] = entry as boolean;
	}
	if (compat.maxTokensField !== undefined) {
		if (compat.maxTokensField !== "max_tokens" && compat.maxTokensField !== "max_completion_tokens") {
			invalid("maxTokensField is invalid", "compat.maxTokensField");
		}
		result.maxTokensField = compat.maxTokensField;
	}
	return result;
}

function parseCustomLlmModel(value: unknown, index: number): CustomLlmModelInput {
	const field = `models[${index}]`;
	const model = object(value, field);
	exactKeys(model, ["id", "name", "reasoning", "input", "cost", "contextWindow", "maxTokens"], field);
	if (model.reasoning !== undefined && typeof model.reasoning !== "boolean") {
		invalid("reasoning must be a boolean", `${field}.reasoning`);
	}
	let input: ("text" | "image")[] | undefined;
	if (model.input !== undefined) {
		if (!Array.isArray(model.input)) invalid("input must be an array", `${field}.input`);
		input = model.input.map((entry, inputIndex) => {
			if (entry !== "text" && entry !== "image") invalid("input entry is invalid", `${field}.input[${inputIndex}]`);
			return entry;
		});
	}
	let cost: CustomLlmModelInput["cost"];
	if (model.cost !== undefined) {
		const source = object(model.cost, `${field}.cost`);
		exactKeys(source, ["input", "output", "cacheRead", "cacheWrite"], `${field}.cost`);
		cost = {};
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			if (source[key] !== undefined) cost[key] = number(source, key);
		}
	}
	return {
		id: string(model, "id", `${field}.id`),
		name: string(model, "name", `${field}.name`),
		...(model.reasoning === undefined ? {} : { reasoning: model.reasoning as boolean }),
		...(input === undefined ? {} : { input }),
		...(cost === undefined ? {} : { cost }),
		contextWindow: number(model, "contextWindow"),
		maxTokens: number(model, "maxTokens"),
	};
}

export function parseConfigureLlmProviderApiKey(providerId: string, value: unknown): ConfigureLlmProviderApiKeyInput {
	const body = object(value, "body");
	exactKeys(body, ["type", "apiKey", "environment", "expectedRevision"]);
	const type = string(body, "type");
	if (type !== "api_key") invalid("type must be api_key", "type");
	const apiKey = optionalString(body, "apiKey");
	const environment = optionalStringRecord(body, "environment");
	const expectedRevision = optionalPositiveInteger(body, "expectedRevision");
	return {
		providerId,
		...(apiKey === undefined ? {} : { apiKey }),
		...(environment === undefined ? {} : { environment }),
		...(expectedRevision === undefined ? {} : { expectedRevision }),
	};
}

export function parseCreateCredential(value: unknown): CreateCredentialInput {
	return parseCredential(value, "body");
}

function parseCredential(value: unknown, prefix: string): CreateCredentialInput {
	const body = object(value, prefix);
	exactKeys(body, ["displayName", "remoteUser", "type", "privateKey", "passphrase", "password"], prefix);
	const type = string(body, "type", `${prefix}.type`);
	let secret: CredentialSecret;
	if (type === "private_key") {
		secret = {
			type,
			privateKey: string(body, "privateKey", `${prefix}.privateKey`),
			...(optionalString(body, "passphrase", `${prefix}.passphrase`) === undefined
				? {}
				: { passphrase: optionalString(body, "passphrase", `${prefix}.passphrase`) }),
		};
		if (body.password !== undefined) {
			invalid("password is not valid for a private_key Credential", `${prefix}.password`);
		}
	} else if (type === "password") {
		secret = { type, password: string(body, "password", `${prefix}.password`) };
		if (body.privateKey !== undefined || body.passphrase !== undefined) {
			invalid("privateKey and passphrase are not valid for a password Credential", `${prefix}.privateKey`);
		}
	} else {
		invalid("type must be private_key or password", `${prefix}.type`);
	}
	return {
		displayName: string(body, "displayName", `${prefix}.displayName`),
		remoteUser: string(body, "remoteUser", `${prefix}.remoteUser`),
		secret,
	};
}

export function parseCreateWorkspace(value: unknown): CreateWorkspaceInput {
	const body = object(value, "body");
	exactKeys(body, ["displayName", "environment", "host", "credential", "defaultCwd", "connection"]);
	const host = object(body.host, "host");
	exactKeys(host, ["hostname", "port"], "host");
	const environment = parseEnvironment(string(body, "environment"));
	const connectionValue = body.connection;
	let connection: CreateWorkspaceInput["connection"];
	if (connectionValue !== undefined) {
		const source = object(connectionValue, "connection");
		exactKeys(source, ["connectTimeoutMs", "keepaliveIntervalMs", "keepaliveMaxCount"]);
		connection = {
			...(source.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: number(source, "connectTimeoutMs") }),
			...(source.keepaliveIntervalMs === undefined
				? {}
				: { keepaliveIntervalMs: number(source, "keepaliveIntervalMs") }),
			...(source.keepaliveMaxCount === undefined ? {} : { keepaliveMaxCount: number(source, "keepaliveMaxCount") }),
		};
	}
	return {
		displayName: string(body, "displayName"),
		environment,
		host: {
			hostname: string(host, "hostname"),
			port: number(host, "port"),
		},
		credential: parseCredential(body.credential, "credential"),
		defaultCwd: string(body, "defaultCwd"),
		...(connection === undefined ? {} : { connection }),
	};
}

export function parseActivateCredential(value: unknown): { credentialId: string; expectedRevision: number } {
	const body = object(value, "body");
	exactKeys(body, ["credentialId", "expectedRevision"]);
	return {
		credentialId: string(body, "credentialId"),
		expectedRevision: number(body, "expectedRevision"),
	};
}

export function parseRename(value: unknown): { displayName: string; expectedRevision: number } {
	const body = object(value, "body");
	exactKeys(body, ["displayName", "expectedRevision"]);
	return { displayName: string(body, "displayName"), expectedRevision: number(body, "expectedRevision") };
}

export function parseCreateSession(value: unknown): { displayName: string; workDir?: string; autoAudit?: boolean } {
	const body = object(value, "body");
	exactKeys(body, ["displayName", "workDir", "autoAudit"]);
	const workDir = optionalString(body, "workDir");
	if (body.autoAudit !== undefined && typeof body.autoAudit !== "boolean")
		invalid("autoAudit must be a boolean", "autoAudit");
	return {
		displayName: string(body, "displayName"),
		...(workDir === undefined ? {} : { workDir }),
		...(body.autoAudit === undefined ? {} : { autoAudit: body.autoAudit as boolean }),
	};
}

export function parseUpdateSession(value: unknown): {
	displayName?: string;
	workDir?: string | null;
	autoAudit?: boolean;
	expectedRevision: number;
} {
	const body = object(value, "body");
	exactKeys(body, ["displayName", "workDir", "autoAudit", "expectedRevision"]);
	if (body.workDir !== undefined && body.workDir !== null && typeof body.workDir !== "string")
		invalid("workDir must be a string or null", "workDir");
	if (body.autoAudit !== undefined && typeof body.autoAudit !== "boolean")
		invalid("autoAudit must be a boolean", "autoAudit");
	return {
		...(body.displayName === undefined ? {} : { displayName: string(body, "displayName") }),
		...(body.workDir === undefined ? {} : { workDir: body.workDir as string | null }),
		...(body.autoAudit === undefined ? {} : { autoAudit: body.autoAudit as boolean }),
		expectedRevision: number(body, "expectedRevision"),
	};
}

export function parseCreateChatRun(value: unknown): {
	requestId: string;
	providerId?: string;
	modelId?: string;
	thinkingLevel?: ThinkingLevel;
	message: string;
	attachmentIds?: string[];
	serverInteractionMode: "command" | "terminal";
} {
	const body = object(value, "body");
	exactKeys(body, [
		"requestId",
		"providerId",
		"modelId",
		"thinkingLevel",
		"message",
		"attachmentIds",
		"serverInteractionMode",
	]);
	const thinkingLevel = optionalString(body, "thinkingLevel");
	if (thinkingLevel !== undefined && !isThinkingLevel(thinkingLevel))
		invalid("thinkingLevel is invalid", "thinkingLevel");
	const providerId = optionalString(body, "providerId");
	const modelId = optionalString(body, "modelId");
	if ((providerId === undefined) !== (modelId === undefined))
		invalid("providerId and modelId must be provided together", providerId === undefined ? "providerId" : "modelId");
	const serverInteractionMode = string(body, "serverInteractionMode");
	if (serverInteractionMode !== "command" && serverInteractionMode !== "terminal") {
		invalid("serverInteractionMode must be command or terminal", "serverInteractionMode");
	}
	return {
		requestId: string(body, "requestId"),
		...(providerId === undefined ? {} : { providerId }),
		...(modelId === undefined ? {} : { modelId }),
		...(thinkingLevel === undefined ? {} : { thinkingLevel }),
		message: string(body, "message"),
		...parseAttachmentIds(body),
		serverInteractionMode,
	};
}

export function parseEnqueueChatMessage(value: unknown): {
	requestId: string;
	behavior: ChatQueueBehavior;
	message: string;
	attachmentIds?: string[];
} {
	const body = object(value, "body");
	exactKeys(body, ["requestId", "behavior", "message", "attachmentIds"]);
	const behavior = string(body, "behavior");
	if (behavior !== "steer" && behavior !== "follow_up") invalid("behavior must be steer or follow_up", "behavior");
	return {
		requestId: string(body, "requestId"),
		behavior,
		message: string(body, "message"),
		...parseAttachmentIds(body),
	};
}

function parseAttachmentIds(body: JsonObject): { attachmentIds?: string[] } {
	if (body.attachmentIds === undefined) return {};
	if (!Array.isArray(body.attachmentIds)) {
		throw new ChatError("chat_attachment_ids_invalid", "attachmentIds must be an array", 400);
	}
	if (body.attachmentIds.length > MAX_CHAT_IMAGE_ATTACHMENTS) {
		throw new ChatError(
			"chat_attachment_limit_exceeded",
			`A Chat message can contain at most ${MAX_CHAT_IMAGE_ATTACHMENTS} image Attachments`,
			400,
		);
	}
	const attachmentIds = body.attachmentIds.map((value) => {
		if (typeof value !== "string" || value.trim().length === 0) {
			throw new ChatError("chat_attachment_ids_invalid", "attachmentIds must contain non-empty strings", 400);
		}
		return value;
	});
	if (new Set(attachmentIds).size !== attachmentIds.length) {
		throw new ChatError("chat_attachment_ids_invalid", "attachmentIds must not contain duplicates", 400);
	}
	return { attachmentIds };
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max"
	);
}

export function parseGuardUpdate(value: unknown): Omit<UpdateGuardInput, "workspaceId"> {
	const body = object(value, "body");
	exactKeys(body, ["enabled", "rules", "expectedRevision"]);
	if (typeof body.enabled !== "boolean") invalid("enabled must be a boolean", "enabled");
	if (!Array.isArray(body.rules)) invalid("rules must be an array", "rules");
	return {
		enabled: body.enabled,
		rules: body.rules.map((value, index) => parseRule(value, index)),
		expectedRevision: number(body, "expectedRevision"),
	};
}

export function parseGuardRulePackImport(value: unknown): { packIds: string[]; expectedRevision: number } {
	const body = object(value, "body");
	exactKeys(body, ["packIds", "expectedRevision"]);
	if (!Array.isArray(body.packIds)) invalid("packIds must be an array", "packIds");
	return {
		packIds: body.packIds.map((value, index) => {
			if (typeof value !== "string") invalid("packIds entries must be strings", `packIds[${index}]`);
			return value;
		}),
		expectedRevision: number(body, "expectedRevision"),
	};
}

function parseRule(value: unknown, index: number): UpdateCommandGuardRuleInput {
	const field = `rules[${index}]`;
	const rule = object(value, field);
	exactKeys(rule, ["id", "displayName", "pattern", "match", "reason", "enabled"], field);
	const id = optionalString(rule, "id", `${field}.id`);
	const match = string(rule, "match", `${field}.match`);
	if (!isGuardMatch(match)) invalid("match must be contains, starts_with, or regex", `${field}.match`);
	if (typeof rule.enabled !== "boolean") invalid("enabled must be a boolean", `${field}.enabled`);
	const reason = optionalString(rule, "reason", `${field}.reason`);
	return {
		...(id === undefined ? {} : { id }),
		displayName: string(rule, "displayName", `${field}.displayName`),
		pattern: string(rule, "pattern", `${field}.pattern`),
		match,
		...(reason === undefined ? {} : { reason }),
		enabled: rule.enabled,
	};
}

function object(value: unknown, field: string): JsonObject {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		invalid(`${field} must be an object`, field);
	return value as JsonObject;
}

function string(source: JsonObject, field: string, errorField = field): string {
	const value = source[field];
	if (typeof value !== "string") invalid(`${field} must be a string`, errorField);
	return value;
}

function optionalString(source: JsonObject, field: string, errorField = field): string | undefined {
	const value = source[field];
	if (value === undefined) return undefined;
	if (typeof value !== "string") invalid(`${field} must be a string`, errorField);
	return value;
}

function optionalStringRecord(source: JsonObject, field: string): Record<string, string> | undefined {
	const value = source[field];
	if (value === undefined) return undefined;
	const record = object(value, field);
	for (const [key, entry] of Object.entries(record)) {
		if (typeof entry !== "string") invalid(`${field}.${key} must be a string`, `${field}.${key}`);
	}
	return record as Record<string, string>;
}

function optionalPositiveInteger(source: JsonObject, field: string): number | undefined {
	const value = source[field];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		invalid(`${field} must be a positive integer`, field);
	}
	return value;
}

function requiredPositiveInteger(source: JsonObject, field: string): number {
	const value = optionalPositiveInteger(source, field);
	if (value === undefined) invalid(`${field} is required`, field);
	return value;
}

function number(source: JsonObject, field: string): number {
	const value = source[field];
	if (typeof value !== "number" || !Number.isFinite(value)) invalid(`${field} must be a number`, field);
	return value;
}

function exactKeys(source: JsonObject, allowed: readonly string[], prefix = "body"): void {
	const allowedSet = new Set(allowed);
	const unexpected = Object.keys(source).find((key) => !allowedSet.has(key));
	if (unexpected !== undefined) invalid(`${unexpected} cannot be edited`, `${prefix}.${unexpected}`);
}

function parseEnvironment(value: string): WorkspaceEnvironment {
	if (value === "production" || value === "staging" || value === "development" || value === "other") return value;
	return invalid("environment is invalid", "environment");
}

function isGuardMatch(value: string): value is CommandGuardMatch {
	return value === "contains" || value === "starts_with" || value === "regex";
}

function invalid(message: string, field: string): never {
	throw new ManagementError("validation_error", message, field);
}
