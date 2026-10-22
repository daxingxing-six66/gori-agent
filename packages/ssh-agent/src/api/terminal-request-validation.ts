import { ManagementError } from "../domain/errors.ts";
import { Buffer } from "node:buffer";
import { TERMINAL_DEFAULTS } from "../application/terminal/terminal-defaults.ts";
import type { TerminalHumanInputRequest } from "../domain/terminal-human.ts";

type JsonObject = Record<string, unknown>;

export function parseTerminalControl(value: unknown): { claim: boolean } {
	const body = object(value);
	exactKeys(body, ["action"]);
	if (body.action !== "claim" && body.action !== "release") invalid("action must be claim or release", "action");
	return { claim: body.action === "claim" };
}

export function parseTerminalHumanInput(value: unknown): TerminalHumanInputRequest {
	const body = object(value);
	exactKeys(body, ["terminalSessionId", "controlEpoch", "inputSequence", "bytesBase64"]);
	const encoded = string(body, "bytesBase64");
	if (encoded.length > Math.ceil(TERMINAL_DEFAULTS.input.maxBytes / 3) * 4 ||
		! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
		invalid("bytesBase64 must be bounded base64", "bytesBase64");
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.length === 0 || bytes.length > TERMINAL_DEFAULTS.input.maxBytes) invalid("input batch is empty or too large", "bytesBase64");
	return { terminalSessionId: string(body, "terminalSessionId"), controlEpoch: positiveInteger(body, "controlEpoch"),
		inputSequence: positiveInteger(body, "inputSequence"), bytes };
}

export function parseOpenTerminal(value: unknown): {
	readonly requestId: string;
	readonly rows?: number;
	readonly cols?: number;
} {
	const body = object(value);
	exactKeys(body, ["requestId", "rows", "cols"]);
	const rows = optionalInteger(body, "rows");
	const cols = optionalInteger(body, "cols");
	return {
		requestId: string(body, "requestId"),
		...(rows === undefined ? {} : { rows }),
		...(cols === undefined ? {} : { cols }),
	};
}

export function parseCloseTerminal(value: unknown): {
	readonly requestId: string;
	readonly terminalSessionId: string;
} {
	const body = object(value);
	exactKeys(body, ["requestId", "terminalSessionId"]);
	return { requestId: string(body, "requestId"), terminalSessionId: string(body, "terminalSessionId") };
}

export function parseCreateTerminalAttachment(value: unknown): { readonly requestId: string } {
	const body = object(value);
	exactKeys(body, ["requestId"]);
	return { requestId: string(body, "requestId") };
}

export function parseTerminalReady(value: unknown): { readonly replayedThroughSequence: number } {
	const body = object(value);
	exactKeys(body, ["replayedThroughSequence"]);
	return { replayedThroughSequence: nonNegativeInteger(body, "replayedThroughSequence") };
}

export function parseTerminalFocus(value: unknown): { readonly focused: boolean } {
	const body = object(value);
	exactKeys(body, ["focused"]);
	if (typeof body.focused !== "boolean") invalid("focused must be a boolean", "focused");
	return { focused: body.focused };
}

export function parseTerminalResize(value: unknown): {
	readonly ownershipEpoch: number;
	readonly rows: number;
	readonly cols: number;
} {
	const body = object(value);
	exactKeys(body, ["ownershipEpoch", "rows", "cols"]);
	return {
		ownershipEpoch: positiveInteger(body, "ownershipEpoch"),
		rows: positiveInteger(body, "rows"),
		cols: positiveInteger(body, "cols"),
	};
}

function object(value: unknown): JsonObject {
	if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("body must be an object", "body");
	return value as JsonObject;
}

function exactKeys(source: JsonObject, allowed: readonly string[]): void {
	const allowedSet = new Set(allowed);
	const unexpected = Object.keys(source).find((key) => !allowedSet.has(key));
	if (unexpected !== undefined) invalid(`${unexpected} is not allowed`, `body.${unexpected}`);
}

function string(source: JsonObject, field: string): string {
	const value = source[field];
	if (typeof value !== "string" || value.length === 0) invalid(`${field} must be a non-empty string`, field);
	return value;
}

function optionalInteger(source: JsonObject, field: string): number | undefined {
	const value = source[field];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value)) invalid(`${field} must be an integer`, field);
	return value;
}

function positiveInteger(source: JsonObject, field: string): number {
	const value = optionalInteger(source, field);
	if (value === undefined || value <= 0) invalid(`${field} must be a positive integer`, field);
	return value;
}

function nonNegativeInteger(source: JsonObject, field: string): number {
	const value = optionalInteger(source, field);
	if (value === undefined || value < 0) invalid(`${field} must be a non-negative integer`, field);
	return value;
}

function invalid(message: string, field: string): never {
	throw new ManagementError("validation_error", message, field);
}
