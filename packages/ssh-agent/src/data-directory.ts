import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Resolve private application data independently of the source checkout. */
export function resolveDataDirectory(environment: NodeJS.ProcessEnv = process.env): string {
	const value = environment.SSH_AGENT_DATA_DIR?.trim() || join(homedir(), ".gori-agent");
	return resolve(value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value);
}
