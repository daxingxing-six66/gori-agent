import { StringDecoder } from "node:string_decoder";
import type { RemoteSandboxCoordinator } from "../../infrastructure/sandbox/remote-sandbox-coordinator.ts";
import { SshAgentError } from "../../domain/ssh-failure.ts";
import type { SshTargetSnapshot } from "../../domain/ssh-target.ts";
import type { RemoteCommandBroker } from "../ssh-channel-broker.ts";
import type { CommandOperationService } from "./command-operation-service.ts";
import type { SshTargetResolver } from "./ssh-target-resolver.ts";

export type BubblewrapPackageManager = "apt-get" | "dnf" | "yum" | "zypper" | "apk";
export interface BubblewrapInstallPlan {
	packageManager: BubblewrapPackageManager;
	useSudo: boolean;
	refreshIndex: boolean;
}

export const BUBBLEWRAP_INSTALL_TIMEOUT_MS = 600_000;
export const BUBBLEWRAP_INSTALL_JUSTIFICATION = "Install Bubblewrap after Landlock is unavailable";

/** Generates the exact shell script shown in approval and later checked by the Full Access grant. */
export function bubblewrapInstallCommand(plan: BubblewrapInstallPlan): string {
	const prefix = plan.useSudo ? "sudo -n " : "";
	const install = plan.packageManager === "apt-get"
		? "env DEBIAN_FRONTEND=noninteractive apt-get install -y bubblewrap"
		: plan.packageManager === "dnf" ? "dnf install -y bubblewrap"
		: plan.packageManager === "yum" ? "yum install -y bubblewrap"
		: plan.packageManager === "zypper" ? "zypper --non-interactive install bubblewrap"
		: "apk add --no-cache bubblewrap";
	const refresh = plan.packageManager === "apt-get" ? "apt-get update"
		: plan.packageManager === "dnf" ? "dnf makecache"
		: plan.packageManager === "yum" ? "yum makecache"
		: plan.packageManager === "zypper" ? "zypper --non-interactive refresh"
		: "apk update";
	return `set -e; ${plan.refreshIndex ? `${prefix}${refresh}; ` : ""}${prefix}${install}`;
}

export function parseBubblewrapInstallPlan(value: unknown): BubblewrapInstallPlan {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Bubblewrap installation plan");
	const plan = value as Record<string, unknown>;
	if (plan.packageManager !== "apt-get" && plan.packageManager !== "dnf" && plan.packageManager !== "yum" &&
		plan.packageManager !== "zypper" && plan.packageManager !== "apk") throw new Error("Unsupported Bubblewrap package manager");
	if (typeof plan.useSudo !== "boolean" || typeof plan.refreshIndex !== "boolean") throw new Error("Invalid Bubblewrap installation options");
	return { packageManager: plan.packageManager, useSudo: plan.useSudo, refreshIndex: plan.refreshIndex };
}

export class BubblewrapInstallationService {
	readonly #targets: SshTargetResolver;
	readonly #sandbox: Pick<RemoteSandboxCoordinator, "probe">;
	readonly #broker: RemoteCommandBroker;
	readonly #operations: CommandOperationService;

	constructor(options: {
		targets: SshTargetResolver;
		sandbox: Pick<RemoteSandboxCoordinator, "probe">;
		broker: RemoteCommandBroker;
		operations: CommandOperationService;
	}) {
		this.#targets = options.targets;
		this.#sandbox = options.sandbox;
		this.#broker = options.broker;
		this.#operations = options.operations;
	}

	async requireInstallation(sessionId: string, signal: AbortSignal): Promise<SshTargetSnapshot> {
		const target = await this.#targets.resolve(sessionId);
		try {
			await this.#sandbox.probe(target, signal);
		} catch (error) {
			if (error instanceof SshAgentError && error.failure.code === "sandbox_bubblewrap_not_installed") return target;
			throw error;
		}
		throw new Error("A remote sandbox is already available; Bubblewrap installation is unnecessary");
	}

	async inspect(sessionId: string, signal: AbortSignal): Promise<string> {
		const target = await this.requireInstallation(sessionId, signal);
		let output = "";
		const decoder = new StringDecoder("utf8");
		const result = await this.#broker.execute({ target, signal,
			command: 'printf "uid="; id -u; cat /etc/os-release; for manager in apt-get dnf yum zypper apk; do if command -v "$manager" >/dev/null 2>&1; then printf "manager=%s\\n" "$manager"; fi; done; if command -v sudo >/dev/null 2>&1; then printf "sudo=present\\n"; fi',
			onStdout: async (chunk) => {
				output += decoder.write(Buffer.from(chunk));
				if (output.length > 8_192) throw new Error("Bubblewrap installation inspection output exceeded its limit");
			}, onStderr: async () => {} });
		if (result.exitCode !== 0 || result.exitSignal) throw new Error("Could not inspect remote package manager");
		return output + decoder.end();
	}

	async install(input: {
		sessionId: string;
		agentRunId: string;
		toolCallId: string;
		plan: BubblewrapInstallPlan;
		signal: AbortSignal;
	}): Promise<string> {
		const target = await this.requireInstallation(input.sessionId, input.signal);
		const result = await this.#operations.submit({
			sessionId: input.sessionId,
			agentRunId: input.agentRunId,
			toolCallId: input.toolCallId,
			command: bubblewrapInstallCommand(input.plan),
			cwd: "/",
			timeoutMs: BUBBLEWRAP_INSTALL_TIMEOUT_MS,
			sandboxPermissions: "full_access",
			justification: BUBBLEWRAP_INSTALL_JUSTIFICATION,
			expectedTarget: target,
			signal: input.signal,
		});
		if (result.operation.failure) throw new Error(`Bubblewrap installation failed: ${result.operation.failure.message}\n${result.outputTail}`);
		const facts = await this.#sandbox.probe(target, input.signal);
		return `Bubblewrap installation completed. Active sandbox: ${facts.backend}. ${result.outputTail}`;
	}
}
