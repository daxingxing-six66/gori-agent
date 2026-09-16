import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { COMMAND_EXECUTION_DEFAULTS } from "../application/services/command-operation-service.ts";
import type { CreateSshAgentServerOptions } from "./ssh-agent-server.ts";

const DEFAULT_ALLOWED_ORIGINS = [
	"http://localhost:3000",
	"http://127.0.0.1:3000",
	"http://localhost:5173",
	"http://127.0.0.1:5173",
] as const;

export interface SshAgentServerEnvironmentConfig extends Omit<CreateSshAgentServerOptions, "llmModelsFactory"> {
	host: string;
	port: number;
	allowedOrigins: readonly string[];
}

export function readSshAgentServerEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): SshAgentServerEnvironmentConfig {
	const databaseValue = required(environment, "SSH_AGENT_DATABASE_PATH");
	const keyValue = required(environment, "SSH_AGENT_CREDENTIAL_KEY_BASE64");
	const credentialEncryptionKey = decodeEncryptionKey(keyValue);
	const host = environment.SSH_AGENT_HOST?.trim() || "127.0.0.1";
	const port = integer(environment.SSH_AGENT_PORT, "SSH_AGENT_PORT", 3001, 1, 65_535);
	const maxConcurrentOperations = integer(
		environment.SSH_AGENT_MAX_CONCURRENT_OPERATIONS,
		"SSH_AGENT_MAX_CONCURRENT_OPERATIONS",
		COMMAND_EXECUTION_DEFAULTS.maxConcurrentOperations,
		1,
		Number.MAX_SAFE_INTEGER,
	);
	const allowedOrigins =
		environment.SSH_AGENT_CORS_ORIGINS === undefined
			? DEFAULT_ALLOWED_ORIGINS
			: environment.SSH_AGENT_CORS_ORIGINS.split(",")
					.map((origin) => origin.trim())
					.filter((origin) => origin.length > 0);
	const maxRequestBodyBytes = optionalInteger(
		environment.SSH_AGENT_MAX_REQUEST_BODY_BYTES,
		"SSH_AGENT_MAX_REQUEST_BODY_BYTES",
		1,
		Number.MAX_SAFE_INTEGER,
	);
	const localCwd = localDirectory(environment.SSH_AGENT_LOCAL_CWD);
	return {
		databasePath: databaseValue === ":memory:" ? databaseValue : resolve(databaseValue),
		credentialEncryptionKey,
		host,
		port,
		maxConcurrentOperations,
		allowedOrigins,
		localCwd,
		...(maxRequestBodyBytes === undefined ? {} : { maxRequestBodyBytes }),
	};
}

function localDirectory(value: string | undefined): string {
	const candidate = value?.trim() || join(homedir(), ".ssh-agent", "workspace");
	const expanded =
		candidate === "~" ? homedir() : candidate.startsWith("~/") ? join(homedir(), candidate.slice(2)) : candidate;
	if (!isAbsolute(expanded)) throw new Error("SSH_AGENT_LOCAL_CWD must be absolute or start with ~/");
	return resolve(expanded);
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
	const value = environment[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function decodeEncryptionKey(value: string): Uint8Array {
	const decoded = Buffer.from(value, "base64");
	if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
		throw new Error("SSH_AGENT_CREDENTIAL_KEY_BASE64 must be canonical base64 for exactly 32 bytes");
	}
	return decoded;
}

function integer(value: string | undefined, name: string, fallback: number, minimum: number, maximum: number): number {
	if (value === undefined) return fallback;
	return parseInteger(value, name, minimum, maximum);
}

function optionalInteger(
	value: string | undefined,
	name: string,
	minimum: number,
	maximum: number,
): number | undefined {
	return value === undefined ? undefined : parseInteger(value, name, minimum, maximum);
}

function parseInteger(value: string, name: string, minimum: number, maximum: number): number {
	if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`${name} must be between ${minimum} and ${maximum}`);
	}
	return parsed;
}
