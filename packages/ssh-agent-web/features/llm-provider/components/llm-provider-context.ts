"use client";

import { createContext, useContext } from "react";
import type { LlmProvider } from "@/features/llm-provider/model/llm-provider";

export interface LlmProviderContextValue {
	providers: readonly LlmProvider[] | null;
	loading: boolean;
	error: unknown;
	refreshProviders(): Promise<readonly LlmProvider[]>;
}

export const LlmProviderContext = createContext<LlmProviderContextValue | null>(null);

export function useLlmProviders(): LlmProviderContextValue {
	const value = useContext(LlmProviderContext);
	if (value === null) throw new Error("useLlmProviders must be used inside LlmProviderProvider");
	return value;
}
