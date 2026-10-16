import { DeploymentError } from "../domain/deployment.ts";

/** Only explicit input facts belong here; do not reclassify infrastructure exceptions. */
export function deploymentInputError(code: string, field: string, reason: string): never {
	throw new DeploymentError(code, `${field}: ${reason}`, 400, { field });
}

export function deploymentObject(value: unknown, field: string, allowed: readonly string[], code: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		deploymentInputError(code, field, "must be a JSON object");
	const object = value as Record<string, unknown>;
	const unknown = Object.keys(object).find((key) => !allowed.includes(key));
	if (unknown !== undefined) deploymentInputError(code, field === "proposal" || field === "request" ? unknown : `${field}.${unknown}`,
		`unknown field; allowed fields: ${allowed.join(", ")}`);
	return object;
}

export function deploymentText(value: unknown, field: string, max: number, code: string): string {
	if (typeof value !== "string") deploymentInputError(code, field, "must be a string");
	if (!value.trim()) deploymentInputError(code, field, "must not be empty or whitespace");
	if (value.length > max) deploymentInputError(code, field, `must be at most ${max} characters; received ${value.length}`);
	if (/[\0-\x08\x0b\x0c\x0e-\x1f]/u.test(value)) deploymentInputError(code, field, "must not contain control characters");
	return value.trim();
}

export function deploymentArray(value: unknown, field: string, max: number, code: string): unknown[] {
	if (!Array.isArray(value)) deploymentInputError(code, field, "must be an array");
	if (value.length < 1 || value.length > max) deploymentInputError(code, field, `must contain 1 to ${max} entries; received ${value.length}`);
	return value;
}

export function deploymentJsonSize(value: unknown, code: string): void {
	let serialized: string;
	try { serialized = JSON.stringify(value); }
	catch { deploymentInputError(code, "proposal", "must be serializable JSON without circular references"); }
	if (Buffer.byteLength(serialized, "utf8") > 96 * 1024) deploymentInputError(code, "proposal", "must be at most 96 KiB of JSON");
}
