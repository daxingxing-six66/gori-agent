import ssh2, { Client } from "ssh2";
import type { SshConnectionTester, SshConnectionTestInput } from "../../application/services/connection-test-service.ts";
import { SshAgentError, type SshFailureCode } from "../../domain/ssh-failure.ts";
import { SUPPORTED_SSH_HOST_KEY_ALGORITHMS } from "./ssh-host-key.ts";

/** One temporary, authentication-only connection. Never opens a channel or stores trust. */
export class Ssh2ConnectionTester implements SshConnectionTester {
	readonly #active = new Set<() => void>();
	#closed = false;

	async test(input: SshConnectionTestInput, signal?: AbortSignal): Promise<void> {
		if (this.#closed || signal?.aborted) throw failure("execution_cancelled");
		if (input.secret.type === "private_key") {
			const parsed = ssh2.utils.parseKey(input.secret.privateKey, input.secret.passphrase);
			if (parsed instanceof Error || !(Array.isArray(parsed) ? parsed : [parsed]).every((key) => key.isPrivateKey())) {
				throw failure("invalid_private_key");
			}
		}
		const client = new Client();
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (error?: SshAgentError) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", cancel);
				this.#active.delete(cancel);
				client.destroy();
				if (error) reject(error); else resolve();
			};
			const cancel = () => finish(failure("execution_cancelled"));
			const timer = setTimeout(() => finish(failure("connection_timeout")), input.connection.connectTimeoutMs);
			this.#active.add(cancel);
			signal?.addEventListener("abort", cancel, { once: true });
			client.once("ready", () => finish());
			client.once("close", () => finish(failure("transport_lost")));
			// Keep an error listener through destroy: late socket errors must not escape.
			client.on("error", (error: Error & { code?: string; level?: string }) => finish(classify(error)));
			try {
				client.connect({
					host: input.host.hostname, port: input.host.port, username: input.remoteUser,
					readyTimeout: input.connection.connectTimeoutMs,
					keepaliveInterval: input.connection.keepaliveIntervalMs,
					keepaliveCountMax: input.connection.keepaliveMaxCount,
					algorithms: { serverHostKey: [...SUPPORTED_SSH_HOST_KEY_ALGORITHMS] },
					hostVerifier: () => true,
					...(input.secret.type === "password"
						? { password: input.secret.password }
						: { privateKey: input.secret.privateKey, passphrase: input.secret.passphrase }),
				});
			} catch {
				finish(failure("invalid_request"));
			}
		});
	}

	close(): void {
		this.#closed = true;
		for (const cancel of this.#active) cancel();
	}
}

function classify(error: Error & { code?: string; level?: string }): SshAgentError {
	if (error.level === "client-authentication") return failure("authentication_failed");
	if (error.level === "client-timeout" || error.code === "ETIMEDOUT") return failure("connection_timeout");
	if (error.level === "handshake" && error.message === "Handshake failed: no matching host key format") return failure("host_key_algorithm_unsupported");
	switch (error.code) {
		case "ECONNREFUSED": return failure("connection_refused");
		case "ENOTFOUND": case "EAI_AGAIN": return failure("dns_lookup_failed");
		case "ENETUNREACH": case "EHOSTUNREACH": return failure("network_unreachable");
		default: return failure("transport_lost");
	}
}

function failure(code: SshFailureCode): SshAgentError {
	return new SshAgentError({
		code,
		category: code === "authentication_failed" || code === "invalid_private_key" ? "authentication" : code === "invalid_request" ? "request" : "connection",
		phase: code === "authentication_failed" ? "authenticate" : code === "invalid_private_key" ? "validate" : "connect",
		message: `SSH connection test failed: ${code}`,
		retryable: false,
	});
}
