import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenTerminalChannelInput } from "../src/application/ssh-channel-broker.ts";
import { TerminalChannelDiagnostics } from "../src/infrastructure/ssh/ssh2-terminal-channel-diagnostics.ts";

const input: OpenTerminalChannelInput = {
	target: { workspaceId: "workspace-1", workspaceRevision: 1, credentialId: "PRIVATE_CREDENTIAL",
		credentialAuthVersion: 1, hostname: "PRIVATE_HOST", port: 22, remoteUser: "PRIVATE_USER",
		hostKeyAlgorithm: "ssh-ed25519", hostKeyFingerprint: "PRIVATE_FINGERPRINT",
		connectTimeoutMs: 1000, keepaliveIntervalMs: 1000, keepaliveMaxCount: 3 },
	diagnosticContext: { sessionId: "session-1", terminalSessionId: "terminal-1", sandboxBackend: "bubblewrap" },
	launch: { kind: "sandboxed_exec", command: "PRIVATE_COMMAND", confirmation: "PRIVATE_NONCE" },
	geometry: { rows: 24, cols: 80 }, term: "xterm-256color", signal: new AbortController().signal,
	onData: () => undefined,
};

afterEach(() => vi.useRealTimers());

describe("Terminal channel exit diagnostics", () => {
	it("correlates a remote SIGINT with the last dispatched write and no local shutdown", () => {
		vi.useFakeTimers(); vi.setSystemTime(1000);
		const records: Readonly<Record<string, unknown>>[] = [];
		const diagnostics = new TerminalChannelDiagnostics(input, 7, record => records.push(record));
		diagnostics.startOutput();
		vi.setSystemTime(1010); diagnostics.write(1);
		expect(records).toHaveLength(1); // No per-key log records.
		vi.setSystemTime(1020); diagnostics.exited(null, "SIGINT");
		diagnostics.closed("channel_close", "closed");
		expect(records.map(record => record.event)).toEqual(["terminal.channel.opened", "terminal.channel.exit", "terminal.channel.closed"]);
		expect(records[2]).toMatchObject({ backendProcessId: process.pid, workspaceId: "workspace-1", sessionId: "session-1",
			terminalSessionId: "terminal-1", sandboxBackend: "bubblewrap", launchKind: "sandboxed_exec", connectionGeneration: 7,
			exitReported: true, exitCode: null, exitSignal: "INT", localCloseRequested: false, localDisposeRequested: false,
			outputStarted: true, writeCount: 1, lastWriteAt: 1010, lastWriteByteLength: 1, closeSource: "channel_close", kind: "closed" });
		expect(records[0]?.channelId).toEqual(records[2]?.channelId);
		expect(JSON.stringify(records)).not.toContain("PRIVATE_");
	});

	it("distinguishes exit status zero from a channel closed without an SSH exit report", () => {
		const reported: Readonly<Record<string, unknown>>[] = [], missing: Readonly<Record<string, unknown>>[] = [];
		const normal = new TerminalChannelDiagnostics(input, 1, record => reported.push(record));
		normal.exited(0); normal.closed("channel_close", "closed");
		const transport = new TerminalChannelDiagnostics(input, 1, record => missing.push(record));
		transport.closed("transport_close", "connection_lost");
		expect(reported.at(-1)).toMatchObject({ exitReported: true, exitCode: 0, exitSignal: null });
		expect(missing.at(-1)).toMatchObject({ exitReported: false, exitCode: null, exitSignal: null, closeSource: "transport_close" });
	});

	it("retains local shutdown provenance and omits an unrecognized remote signal string", () => {
		const records: Readonly<Record<string, unknown>>[] = [];
		const diagnostics = new TerminalChannelDiagnostics(input, 1, record => records.push(record));
		diagnostics.requestClose(); diagnostics.requestDispose(); diagnostics.exited(null, "PRIVATE_SIGNAL_DESCRIPTION");
		diagnostics.closed("channel_error", "error");
		expect(records.at(-1)).toMatchObject({ localCloseRequested: true, localDisposeRequested: true, exitSignal: "unknown" });
		expect(JSON.stringify(records)).not.toContain("PRIVATE_");
	});

	it("does not interfere with channel operations when diagnostic output throws", () => {
		const diagnostics = new TerminalChannelDiagnostics(input, 1, () => { throw new Error("log failed"); });
		expect(() => { diagnostics.startOutput(); diagnostics.write(1); diagnostics.exited(null, "INT");
			diagnostics.requestClose(); diagnostics.requestDispose(); diagnostics.closed("channel_close", "closed"); }).not.toThrow();
	});
});
