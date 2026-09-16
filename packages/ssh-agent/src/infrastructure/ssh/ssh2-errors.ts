import { randomUUID } from "node:crypto";
import { SshAgentError, type SshFailure } from "../../domain/ssh-failure.ts";
import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";

export function createSshError(
	code: SshFailure["code"],
	category: SshFailure["category"],
	phase: SshFailure["phase"],
	message: string,
	safeDetails?: SshFailure["safeDetails"],
	retryable = false,
	cause?: Error,
): SshAgentError {
	return new SshAgentError(
		{ code, category, phase, message, retryable, ...(safeDetails ? { safeDetails } : {}) },
		cause,
	);
}

export function classifyConnectionError(
	error: Error,
	target: SshTargetSnapshot,
	observedFingerprint?: string,
): SshAgentError {
	if (observedFingerprint && observedFingerprint !== target.hostKeyFingerprint) {
		return createSshError(
			"host_key_mismatch",
			"host_trust",
			"verify_host",
			"SSH host key fingerprint does not match the trusted Workspace value",
			{
				expectedFingerprint: target.hostKeyFingerprint,
				observedFingerprint,
			},
			false,
			error,
		);
	}
	const candidate = error as Error & { code?: string; level?: string };
	if (candidate.level === "handshake" && candidate.message === "Handshake failed: no matching host key format") {
		return createSshError(
			"host_key_mismatch",
			"host_trust",
			"verify_host",
			"SSH server no longer offers the trusted Workspace host key algorithm",
			{ expectedAlgorithm: target.hostKeyAlgorithm },
			false,
			error,
		);
	}
	if (candidate.level === "client-authentication") {
		return createSshError(
			"authentication_failed",
			"authentication",
			"authenticate",
			"SSH authentication failed",
			undefined,
			false,
			error,
		);
	}
	switch (candidate.code) {
		case "ECONNREFUSED":
			return createSshError(
				"connection_refused",
				"connection",
				"connect",
				"SSH connection was refused",
				undefined,
				true,
				error,
			);
		case "ENOTFOUND":
		case "EAI_AGAIN":
			return createSshError(
				"dns_lookup_failed",
				"connection",
				"connect",
				"SSH hostname could not be resolved",
				undefined,
				true,
				error,
			);
		case "ETIMEDOUT":
			return createSshError(
				"connection_timeout",
				"connection",
				"connect",
				"SSH connection timed out",
				undefined,
				true,
				error,
			);
		case "ENETUNREACH":
		case "EHOSTUNREACH":
			return createSshError(
				"network_unreachable",
				"connection",
				"connect",
				"SSH host is unreachable",
				undefined,
				true,
				error,
			);
		default:
			return createSshError(
				"transport_lost",
				"connection",
				"connect",
				"SSH connection could not be established",
				{ errorId: randomUUID() },
				true,
				error,
			);
	}
}
