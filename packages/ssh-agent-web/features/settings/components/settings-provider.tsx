"use client";

import { useMemo, useState, type ReactNode } from "react";
import { SettingsDialog } from "@/components/settings-dialog";
import {
	SettingsContext,
	type SettingsContextValue,
} from "@/features/settings/components/settings-context";

export function SettingsProvider({ children }: { children: ReactNode }) {
	const [settingsOpen, setSettingsOpen] = useState(false);
	const value = useMemo<SettingsContextValue>(
		() => ({
			settingsOpen,
			openSettings: () => setSettingsOpen(true),
			closeSettings: () => setSettingsOpen(false),
		}),
		[settingsOpen],
	);

	return (
		<SettingsContext.Provider value={value}>
			{children}
			{settingsOpen ? <SettingsDialog /> : null}
		</SettingsContext.Provider>
	);
}
