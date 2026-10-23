import { backendMessage } from "../../i18n/message.ts";
import { HttpBoundaryError } from "../failure-policy.ts";

export function modelRefreshFailed(): HttpBoundaryError {
	return new HttpBoundaryError("llm_model_refresh_failed", 502, backendMessage("management.llm_model_refresh_failed"));
}
