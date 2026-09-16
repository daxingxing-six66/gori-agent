import type {
	ContextCompactionSettings,
	ContextCompactionSettingsDraft,
} from "@/features/context-compaction/model/context-compaction-settings";
import { apiRequest } from "@/shared/api/client";

const SETTINGS_PATH = "/api/settings/compaction";

export const contextCompactionSettingsApi = {
	get: (signal?: AbortSignal) => apiRequest<ContextCompactionSettings>(SETTINGS_PATH, { signal }),
	update: (draft: ContextCompactionSettingsDraft, expectedRevision: number, signal?: AbortSignal) =>
		apiRequest<ContextCompactionSettings>(
			`${SETTINGS_PATH}?expectedRevision=${expectedRevision}`,
			{ method: "PUT", body: draft, signal },
		),
};
