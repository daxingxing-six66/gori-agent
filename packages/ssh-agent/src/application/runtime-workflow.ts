/** Separate backend guidance from its quoted Profile/reference JSON. A binding revision
 * is enforced by the tool closure, not a reason to resend identical model guidance. */
export function runtimeWorkflow(scope: string, text: string): { scope: string; instructions: string; data: Record<string, unknown> } {
	const data: Record<string, unknown> = {};
	const instructions = text.split("\n").filter(line => {
		if (!line.startsWith("{") || !line.endsWith("}")) return true;
		let parsed: unknown;
		try { parsed = JSON.parse(line); } catch { return true; }
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true;
		const reference = parsed as Record<string, unknown>;
		if (!("discussionId" in reference || "projectRoot" in reference || "deploymentRunId" in reference)) return true;
		Object.assign(data, reference);
		if ("discussionId" in reference) delete data.revision;
		return false;
	}).join("\n");
	return { scope, instructions, data };
}
