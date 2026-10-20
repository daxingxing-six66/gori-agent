import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { DIAGNOSE_LIMITS, DiagnoseError, diagnoseObject, type DiagnoseToolBinding } from "../../domain/diagnose.ts";
import type { DiagnoseService } from "../services/diagnose-service.ts";
import { toolRequestError } from "./tool-authorization.ts";

export const diagnoseUpdateDefinition = {
	name: "diagnose_update", label: "Record diagnosis",
	description: "Optionally revise the task title, or record a meaningful diagnostic checkpoint when useful. Records contain direction, status and a free explanation (observations, uncertainty, support or reason to change direction). Only the current record is mutable. To append after it, first give it confirmed or unconfirmed status and a nonempty explanation. Unconfirmed is a valid endpoint; proving a cause is not required. Do not record every command or update every turn. No evidence IDs or relationships are required.",
	parameters: Type.Object({ title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), node: Type.Optional(Type.Object({
		action: Type.Union([Type.Literal("append"), Type.Literal("update_current")]),
		direction: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
		status: Type.Optional(Type.Union([Type.Literal("diagnosing"), Type.Literal("confirmed"), Type.Literal("unconfirmed")])),
		explanation: Type.Optional(Type.String()),
	}, { additionalProperties: false })) }, { additionalProperties: false }),
};
export const diagnoseInspectDefinition = {
	name: "diagnose_inspect", label: "Inspect diagnosis records",
	description: "Read saved chronological diagnostic records with complete explanations, latest 20 by default, maximum 50. beforeSequence pages toward older records. This only reads the bound task: it cannot answer a question, search logs or run server commands. No need to inspect before every update. The conclusion body is read separately by the user.",
	parameters: Type.Object({ beforeSequence: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }, { additionalProperties: false }),
};
export const diagnoseFinishDefinition = {
	name: "diagnose_finish", label: "Save diagnostic conclusion",
	description: "Save a complete Markdown conclusion and end this diagnosis atomically. An inconclusive result is valid: explain known facts, uncertainty and limitations freely. No required report sections or evidence references. The UI provides a separate reading page; after saving, give a brief final reply instead of repeating the full report. Ending a Chat Run alone does not end diagnosis.",
	parameters: Type.Object({ conclusionMarkdown: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
};
export const diagnoseToolDefinitions = [diagnoseUpdateDefinition, diagnoseInspectDefinition, diagnoseFinishDefinition];

export function createDiagnoseTools(service: DiagnoseService, binding: Omit<DiagnoseToolBinding, "toolCallId">): AgentTool[] {
	return diagnoseToolDefinitions.map((definition): AgentTool => ({ ...definition, executionMode: "sequential", execute: async (toolCallId, params) => {
		try {
			let result: unknown;
			if (definition.name === "diagnose_update") result = await service.update({ ...binding, toolCallId }, params);
			else if (definition.name === "diagnose_finish") {
				const input = diagnoseObject(params, ["conclusionMarkdown"]);
				const saved = await service.finish({ ...binding, toolCallId }, input.conclusionMarkdown);
				result = { taskId: saved.taskId, status: saved.status, revision: saved.revision, conclusionAvailable: saved.conclusionAvailable };
			} else {
				const input = diagnoseObject(params, ["beforeSequence", "limit"]);
				if ((input.beforeSequence !== undefined && typeof input.beforeSequence !== "number") || (input.limit !== undefined && typeof input.limit !== "number"))
					throw new DiagnoseError("diagnose_request_invalid", "Pagination fields must be integers");
				const page = service.nodes(binding.sessionId, binding.taskId, input.beforeSequence as number | undefined, input.limit as number | undefined);
				// A record with many control characters may expand during JSON escaping. Keep its text intact without JSON escaping.
				if (new TextEncoder().encode(JSON.stringify(page)).length > DIAGNOSE_LIMITS.inspectBytes) return {
					content: [{ type: "text", text: JSON.stringify({ nextBeforeSequence: page.nextBeforeSequence }) }, ...page.nodes.map(({ explanation, ...node }) =>
						({ type: "text" as const, text: `${JSON.stringify(node)}\nExplanation (quoted task data):\n${explanation}` }))], details: {},
				};
				result = page;
			}
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
		} catch (error) {
			if (error instanceof DiagnoseError && error.status < 500) throw toolRequestError(JSON.stringify({ code: error.code, message: error.message, field: error.field }));
			throw error;
		}
	} }));
}
