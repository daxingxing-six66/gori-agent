import { ClipboardList, Hammer, RotateCw, ShieldCheck, Upload } from "lucide-react";
import type { DeployStage } from "../model/deployment";

const STAGE_ICONS = { prepare: ClipboardList, build: Hammer, upload: Upload, restart: RotateCw, verify: ShieldCheck };

/** The plan and execution flow share the same stage identity, regardless of its result. */
export function DeploymentStageIcon({ stage, size = 15 }: { stage: DeployStage; size?: number }) {
	const Icon = STAGE_ICONS[stage];
	return <Icon size={size} aria-hidden="true" />;
}
