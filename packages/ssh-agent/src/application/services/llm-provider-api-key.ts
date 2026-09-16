import type { Credential } from "@earendil-works/pi-ai";
import { ManagementError } from "../../domain/errors.ts";

export function createApiKeyCredential(
	input: { apiKey?: string; environment?: Record<string, string> },
	fieldPrefix = "",
): Credential {
	const apiKeyField = `${fieldPrefix}apiKey`;
	const environmentField = `${fieldPrefix}environment`;
	const key = normalizeOptionalSecret(input.apiKey, apiKeyField);
	const environment = normalizeEnvironment(input.environment, environmentField);
	if (key === undefined && environment === undefined) {
		throw new ManagementError(
			"validation_error",
			`${apiKeyField} or ${environmentField} must configure at least one authentication value`,
			apiKeyField,
		);
	}
	return {
		type: "api_key",
		...(key === undefined ? {} : { key }),
		...(environment === undefined ? {} : { env: environment }),
	};
}

function normalizeOptionalSecret(value: string | undefined, field: string): string | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim();
	if (normalized.length === 0) throw new ManagementError("validation_error", `${field} must not be empty`, field);
	if (normalized.length > 65_536) {
		throw new ManagementError("validation_error", `${field} must not exceed 65536 characters`, field);
	}
	return normalized;
}

function normalizeEnvironment(
	value: Record<string, string> | undefined,
	field: string,
): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	const entries = Object.entries(value);
	if (entries.length === 0) return undefined;
	if (entries.length > 32) {
		throw new ManagementError("validation_error", `${field} must not exceed 32 entries`, field);
	}
	const normalized: Record<string, string> = {};
	for (const [name, rawValue] of entries) {
		if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
			throw new ManagementError("validation_error", `Invalid environment key: ${name}`, `${field}.${name}`);
		}
		if (rawValue.length === 0 || rawValue.length > 65_536) {
			throw new ManagementError(
				"validation_error",
				`Environment value must contain 1 to 65536 characters: ${name}`,
				`${field}.${name}`,
			);
		}
		normalized[name] = rawValue;
	}
	return normalized;
}
