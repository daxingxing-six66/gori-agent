"use client";

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { llmProviderApi } from "@/features/llm-provider/api/llm-provider-api";
import {
	LlmProviderContext,
	type LlmProviderContextValue,
} from "@/features/llm-provider/components/llm-provider-context";
import type { LlmProvider } from "@/features/llm-provider/model/llm-provider";

export function LlmProviderProvider({ children }: { children: ReactNode }) {
	const requestSequence = useRef(0);
	const [providers, setProviders] = useState<readonly LlmProvider[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<unknown>(null);

	const refreshProviders = useCallback(async (): Promise<readonly LlmProvider[]> => {
		const sequence = ++requestSequence.current;
		setLoading(true);
		setError(null);
		try {
			const response = await llmProviderApi.listProviders();
			if (sequence === requestSequence.current) setProviders(response.providers);
			return response.providers;
		} catch (requestError) {
			if (sequence === requestSequence.current) setError(requestError);
			throw requestError;
		} finally {
			if (sequence === requestSequence.current) setLoading(false);
		}
	}, []);

	const value = useMemo<LlmProviderContextValue>(
		() => ({
			providers,
			loading,
			error,
			refreshProviders,
		}),
		[error, loading, providers, refreshProviders],
	);

	return <LlmProviderContext.Provider value={value}>{children}</LlmProviderContext.Provider>;
}
