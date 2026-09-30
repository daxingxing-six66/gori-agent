import type { RemoteSandboxFacts, RemoteSandboxPolicy } from "../../domain/remote-sandbox.ts";
import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";

export interface PreparedRemoteExecution {
	command: string;
	sandbox: RemoteSandboxFacts;
	/** First stderr line emitted only after the launcher has enforced its ruleset. */
	confirmation?: string;
}

export interface RemoteSandboxProvider {
	prepare(input: {
		target: SshTargetSnapshot;
		cwd: string;
		command: string;
		policy: RemoteSandboxPolicy;
		signal: AbortSignal;
	}): Promise<PreparedRemoteExecution>;
}
