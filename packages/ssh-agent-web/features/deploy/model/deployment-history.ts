import type { DeploymentRun } from "./deployment";

export function newestDeploymentRun(first?: DeploymentRun | null, second?: DeploymentRun | null): DeploymentRun | null {
	if (!first) return second ?? null;
	if (!second || first.updatedAt >= second.updatedAt) return first;
	return second;
}

export function deploymentHistoryTime(run: DeploymentRun): number {
	return run.createdAt;
}

export function mergeDeploymentHistory(preferred: DeploymentRun[], other: DeploymentRun[]): DeploymentRun[] {
	const byId = new Map<string, DeploymentRun>();
	for (const run of [...preferred, ...other]) {
		const current = byId.get(run.id);
		if (!current || current.updatedAt < run.updatedAt) byId.set(run.id, run);
	}
	return [...byId.values()].sort((left, right) => deploymentHistoryTime(right) - deploymentHistoryTime(left) || right.id.localeCompare(left.id));
}
