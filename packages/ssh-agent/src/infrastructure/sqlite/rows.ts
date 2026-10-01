import type { Credential } from "../../domain/credential.ts";
import type { CommandGuardRule, Guard } from "../../domain/guard.ts";
import type { Session } from "../../domain/session.ts";
import type { Workspace } from "../../domain/workspace.ts";

export interface CredentialRow {
	id: string;
	workspace_id: string;
	display_name: string;
	type: string;
	remote_user: string;
	public_key_fingerprint: string | null;
	has_passphrase: number;
	auth_version: number;
	revision: number;
	created_at: number;
	updated_at: number;
}

export function credentialFromRow(row: CredentialRow): Credential {
	const base = {
		id: row.id,
		workspaceId: row.workspace_id,
		displayName: row.display_name,
		remoteUser: row.remote_user,
		authVersion: row.auth_version,
		revision: row.revision,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
	if (row.type === "private_key") {
		return {
			...base,
			type: "private_key",
			...(row.public_key_fingerprint === null ? {} : { publicKeyFingerprint: row.public_key_fingerprint }),
			hasPassphrase: row.has_passphrase === 1,
		};
	}
	return { ...base, type: "password" };
}

export interface WorkspaceRow {
	id: string;
	display_name: string;
	environment: Workspace["environment"];
	hostname: string;
	port: number;
	host_key_algorithm: string | null;
	host_key_fingerprint: string | null;
	host_key_verified_at: number | null;
	active_credential_id: string;
	default_cwd: string;
	remote_default_cwd: string;
	connect_timeout_ms: number;
	keepalive_interval_ms: number;
	keepalive_max_count: number;
	revision: number;
	created_at: number;
	updated_at: number;
}

export function workspaceFromRow(row: WorkspaceRow): Workspace {
	const hostKey =
		row.host_key_algorithm === null && row.host_key_fingerprint === null && row.host_key_verified_at === null
			? null
			: requireCompleteHostKey(row);
	return {
		id: row.id,
		displayName: row.display_name,
		environment: row.environment,
		host: {
			hostname: row.hostname,
			port: row.port,
			hostKey,
		},
		activeCredentialId: row.active_credential_id,
		defaultCwd: row.default_cwd,
		remoteDefaultCwd: row.remote_default_cwd,
		connection: {
			connectTimeoutMs: row.connect_timeout_ms,
			keepaliveIntervalMs: row.keepalive_interval_ms,
			keepaliveMaxCount: row.keepalive_max_count,
		},
		revision: row.revision,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function requireCompleteHostKey(row: WorkspaceRow): NonNullable<Workspace["host"]["hostKey"]> {
	if (row.host_key_algorithm === null || row.host_key_fingerprint === null || row.host_key_verified_at === null) {
		throw new Error(`Invalid persisted Workspace host trust: ${row.id}`);
	}
	return {
		algorithm: row.host_key_algorithm,
		fingerprint: row.host_key_fingerprint,
		verifiedAt: row.host_key_verified_at,
	};
}

export interface SessionRow {
	id: string;
	workspace_id: string;
	display_name: string;
	work_dir: string | null;
	auto_audit: number;
	terminal_context_cursor: number;
	revision: number;
	created_at: number;
	updated_at: number;
}

export function sessionFromRow(row: SessionRow): Session {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		displayName: row.display_name,
		workDir: row.work_dir,
		autoAudit: row.auto_audit === 1,
		terminalContextCursor: row.terminal_context_cursor,
		revision: row.revision,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export interface GuardRow {
	id: string;
	workspace_id: string;
	enabled: number;
	rules_json: string;
	revision: number;
	created_at: number;
	updated_at: number;
}

export function guardFromRow(row: GuardRow): Guard {
	const rules: unknown = JSON.parse(row.rules_json);
	if (!Array.isArray(rules)) throw new Error(`Invalid persisted Guard rules: ${row.id}`);
	const normalizedRules = (rules as CommandGuardRule[]).map((rule) => ({
		...rule,
		source: rule.source ?? "user",
		level: rule.level ?? "critical",
	}));
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		enabled: row.enabled === 1,
		rules: normalizedRules,
		revision: row.revision,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
