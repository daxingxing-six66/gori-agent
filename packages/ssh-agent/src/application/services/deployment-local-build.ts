import { executeShellWithCapture, getOrThrow } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { DeploymentError } from "../../domain/deployment.ts";

/** Shares bash's execution, capture, timeout and cancellation implementation. */
export async function executeDeploymentBuild(command: string, cwd: string, signal: AbortSignal,
	appendLog: (chunk: string) => void, field = "buildSteps.command"): Promise<void> {
	signal.throwIfAborted();
	const env = new NodeExecutionEnv({ cwd });
	try {
		const capture = getOrThrow(await executeShellWithCapture(env, command, {
			cwd, inheritEnv: true, timeout: 30 * 60, abortSignal: signal, returnExecutionErrors: true,
			onChunk: (chunk) => appendLog(chunk),
		}));
		signal.throwIfAborted();
		if (capture.cancelled) throw new DeploymentError("deployment_build_cancelled", `${field}: build in ${cwd} was cancelled`, 409, { field, details: { cwd } });
		if (capture.executionError?.code === "timeout")
			throw new DeploymentError("deployment_build_timeout", `${field}: build in ${cwd} exceeded the 30 minute limit`, 409, { field, details: { cwd, timeoutSeconds: 1800 } });
		if (capture.executionError) throw capture.executionError;
		if (capture.exitCode !== 0) throw new DeploymentError("deployment_build_failed", `${field}: Build exited with status ${capture.exitCode} in ${cwd}; inspect this stage log`, 409, { field, details: { cwd, exitCode: capture.exitCode ?? "unknown" } });
	} finally { await env.cleanup(); }
}
