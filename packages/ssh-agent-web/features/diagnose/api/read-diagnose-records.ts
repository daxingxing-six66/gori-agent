import { diagnoseApi } from "./diagnose-api";
import type { DiagnoseNode } from "../model/diagnose";

/** Read every page independently of the UI cache so copying cannot silently omit older records. */
export async function readDiagnoseRecordsJson(sessionId: string, taskId: string, signal: AbortSignal): Promise<string> {
	const pages: DiagnoseNode[][] = [];
	let beforeSequence: number | undefined;
	for (;;) {
		signal.throwIfAborted();
		const page = await diagnoseApi.nodes(sessionId, taskId, beforeSequence, signal);
		signal.throwIfAborted();
		pages.push(page.nodes);
		if (page.nextBeforeSequence === null) break;
		if (!page.nodes.length || page.nextBeforeSequence !== page.nodes[0]!.sequence ||
			(beforeSequence !== undefined && page.nextBeforeSequence >= beforeSequence)) throw new Error("Invalid diagnosis records cursor");
		beforeSequence = page.nextBeforeSequence;
	}
	const nodes = pages.reverse().flat();
	if (nodes.some((node, index) => node.sequence !== index + 1)) throw new Error("Incomplete diagnosis records");
	return JSON.stringify(nodes.map(({ direction, status, explanation }) => ({ direction, status, explanation })), null, 2);
}
