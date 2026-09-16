import { randomUUID } from "node:crypto";
import { Client, type ConnectConfig, type NegotiatedAlgorithms } from "ssh2";
import type { HostKeyProbe, HostKeyProbeInput, ObservedHostKey } from "../../application/host-key-probe.ts";
import { SshAgentError } from "../../domain/ssh-failure.ts";
import { fingerprintSshHostKey, SUPPORTED_SSH_HOST_KEY_ALGORITHMS } from "./ssh-host-key.ts";

const PROBE_USERNAME = "ssh-agent-host-key-probe";

export class Ssh2HostKeyProbe implements HostKeyProbe {
	probe(input: HostKeyProbeInput): Promise<ObservedHostKey> {
		const client = new Client();
		return new Promise<ObservedHostKey>((resolve, reject) => {
			let observedFingerprint: string | undefined;
			let settled = false;
			const onError = (error: Error) => {
				if (settled) return;
				settled = true;
				client.destroy();
				reject(classifyProbeError(error));
			};
			const onHandshake = (negotiated: NegotiatedAlgorithms) => {
				if (settled) return;
				if (observedFingerprint === undefined) {
					onError(new Error("SSH handshake completed without a host key"));
					return;
				}
				settled = true;
				client.removeListener("error", onError);
				client.on("error", () => {});
				client.destroy();
				resolve({ algorithm: negotiated.serverHostKey, fingerprint: observedFingerprint });
			};
			client.once("handshake", onHandshake);
			client.once("error", onError);
			const config: ConnectConfig = {
				host: input.hostname,
				port: input.port,
				username: PROBE_USERNAME,
				readyTimeout: input.timeoutMs,
				algorithms: { serverHostKey: [...SUPPORTED_SSH_HOST_KEY_ALGORITHMS] },
				hostVerifier: (key: Buffer) => {
					observedFingerprint = fingerprintSshHostKey(key);
					return true;
				},
			};
			try {
				client.connect(config);
			} catch (error) {
				onError(error instanceof Error ? error : new Error("SSH host key probe configuration failed"));
			}
		});
	}
}

function classifyProbeError(error: Error): SshAgentError {
	const candidate = error as Error & { code?: string; level?: string };
	if (candidate.level === "handshake" && candidate.message === "Handshake failed: no matching host key format") {
		return new SshAgentError({
			code: "host_key_algorithm_unsupported",
			category: "host_trust",
			phase: "verify_host",
			message: "SSH server does not offer a supported host key algorithm",
			retryable: false,
		});
	}
	if (candidate.level === "client-timeout" || candidate.code === "ETIMEDOUT") {
		return failure("connection_timeout", "SSH host key probe timed out", true);
	}
	switch (candidate.code) {
		case "ECONNREFUSED":
			return failure("connection_refused", "SSH host key probe was refused", true);
		case "ENOTFOUND":
		case "EAI_AGAIN":
			return failure("dns_lookup_failed", "SSH hostname could not be resolved", true);
		case "ENETUNREACH":
		case "EHOSTUNREACH":
			return failure("network_unreachable", "SSH host is unreachable", true);
		default:
			return new SshAgentError({
				code: "transport_lost",
				category: "connection",
				phase: "verify_host",
				message: "SSH host key probe could not complete",
				retryable: true,
				safeDetails: { errorId: randomUUID() },
			});
	}
}

function failure(
	code: "connection_timeout" | "connection_refused" | "dns_lookup_failed" | "network_unreachable",
	message: string,
	retryable: boolean,
): SshAgentError {
	return new SshAgentError({ code, category: "connection", phase: "verify_host", message, retryable });
}
