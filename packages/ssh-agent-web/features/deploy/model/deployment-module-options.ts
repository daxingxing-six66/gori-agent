import type { DeploymentProfileSummary } from "./deployment";

export interface DeploymentModuleOption {
	key: string;
	file: string;
	moduleId: string;
	moduleName: string;
	project: string;
}

export function deploymentModuleOptions(profiles: readonly DeploymentProfileSummary[]): DeploymentModuleOption[] {
	return profiles.flatMap((profile) => profile.modules.map((module) => ({
		key: JSON.stringify([profile.file, module.id]), file: profile.file,
		moduleId: module.id, moduleName: module.name, project: profile.project,
	})));
}
