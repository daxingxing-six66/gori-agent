import { ManagementError } from "../domain/errors.ts";

export function requireDisplayName(value: string, field = "displayName"): string {
	const normalized = value.trim();
	if (normalized.length === 0) throw new ManagementError("validation_error", `${field} is required`, field);
	if (normalized.length > 120) {
		throw new ManagementError("validation_error", `${field} must not exceed 120 characters`, field);
	}
	return normalized;
}

export function requireNonEmpty(value: string, field: string, maxLength: number): string {
	const normalized = value.trim();
	if (normalized.length === 0) throw new ManagementError("validation_error", `${field} is required`, field);
	if (normalized.length > maxLength) {
		throw new ManagementError("validation_error", `${field} must not exceed ${maxLength} characters`, field);
	}
	return normalized;
}

export function requirePositiveRevision(value: number): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new ManagementError("validation_error", "expectedRevision must be a positive integer", "expectedRevision");
	}
	return value;
}
