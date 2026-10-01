import type { RemoteSandboxFacts, RemoteSandboxPolicy } from "../../domain/remote-sandbox.ts";
import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";
import type { TerminalSandboxFacts } from "../../domain/terminal.ts";

export interface PreparedRemoteExecution {
	command: string;
	sandbox: RemoteSandboxFacts;
	/** First stderr line emitted only after the launcher has enforced its ruleset. */
	confirmation?: string;
}

export interface PreparedSandboxedExecution extends PreparedRemoteExecution {
	sandbox: RemoteSandboxFacts & { mode: "workspace_write"; enforcement: "full" };
	confirmation: string;
}

export interface PreparedRemoteTerminal {
	command: string;
	sandbox: Extract<TerminalSandboxFacts, { mode: "workspace_write" }>;
	/** Complete protocol line without its PTY-dependent line ending. */
	confirmation: string;
}

export interface RemoteSandboxProvider {
	prepare(input: {
		target: SshTargetSnapshot;
		cwd: string;
		command: string;
		policy: RemoteSandboxPolicy;
		signal: AbortSignal;
	}): Promise<PreparedRemoteExecution>;
	prepareTerminal(input: { target: SshTargetSnapshot; signal: AbortSignal }): Promise<PreparedRemoteTerminal>;
}

/** Capability check only; it is not proof that a user command has run confined. */
export interface RemoteSandboxProber {
	probe(target: SshTargetSnapshot, signal: AbortSignal): Promise<PreparedSandboxedExecution["sandbox"]>;
}

/** One constrained implementation. Full Access and backend selection belong to the provider. */
export interface RemoteSandboxBackend extends RemoteSandboxProber {
	prepare(input: { target: SshTargetSnapshot; cwd: string; command: string; signal: AbortSignal }): Promise<PreparedSandboxedExecution>;
	prepareTerminal(input: { target: SshTargetSnapshot; signal: AbortSignal }): Promise<PreparedRemoteTerminal>;
}
