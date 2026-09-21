export interface LastModelSelection {
	providerId: string;
	modelId: string;
}

const STORAGE_KEY = "gori:last-model-selection:v1";

// Preferences must never block model selection when browser storage is unavailable.
export function readLastModelSelection(): LastModelSelection | null {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
		if (typeof value !== "object" || value === null) return null;
		if (!("providerId" in value) || typeof value.providerId !== "string" || !value.providerId.trim()) return null;
		if (!("modelId" in value) || typeof value.modelId !== "string" || !value.modelId.trim()) return null;
		return { providerId: value.providerId, modelId: value.modelId };
	} catch {
		return null;
	}
}

export function rememberModelSelection(selection: LastModelSelection): void {
	try {
		const previous = readLastModelSelection();
		if (previous?.providerId === selection.providerId && previous.modelId === selection.modelId) return;
		localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
	} catch {
		// Private browsing or storage quotas do not affect the current conversation.
	}
}
