import { DiagnoseError } from "../../domain/diagnose.ts";

/** Checked inside the caller's short transaction. No business task holds an execution lease across turns. */
export class SessionTaskModePolicy {
	private readonly hasDiagnose: (sessionId: string) => boolean;
	private readonly hasDeploy: (sessionId: string) => boolean;
	constructor(options: { hasDiagnose(sessionId: string): boolean; hasDeploy(sessionId: string): boolean }) {
		this.hasDiagnose = options.hasDiagnose;
		this.hasDeploy = options.hasDeploy;
	}
	assertCanStart(sessionId: string, mode: "diagnose" | "deploy"): void {
		if (mode === "deploy" && this.hasDiagnose(sessionId) || mode === "diagnose" && this.hasDeploy(sessionId))
			throw new DiagnoseError("session_task_mode_conflict", "Exit the active Diagnose or Deploy task before starting another mode", 409);
	}
}
