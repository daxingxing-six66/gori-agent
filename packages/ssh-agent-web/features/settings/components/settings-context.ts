"use client";

import { createContext, useContext } from "react";

export interface SettingsContextValue {
	settingsOpen: boolean;
	openSettings(): void;
	closeSettings(): void;
}
export const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
	const value = useContext(SettingsContext);
	if (value === null) throw new Error("useSettings must be used inside SettingsProvider");
	return value;
}
