"use client";

import { Bot, Palette, Settings2, Shrink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { ContextCompactionSettings } from "@/features/context-compaction/components/context-compaction-settings";
import { LanguageSelector } from "@/features/i18n/components/language-selector";
import { LlmProviderSettings } from "@/features/llm-provider/components/llm-provider-settings";
import { useSettings } from "@/features/settings/components/settings-context";
import { SettingsSectionPanel } from "@/features/settings/components/settings-section-panel";
import { ThemeSelector } from "@/features/theme/components/theme-selector";

type SettingsSection = "appearance" | "context-compaction" | "llm-provider";

export function SettingsDialog() {
	const intl = useIntl();
	const dialogRef = useRef<HTMLDivElement>(null);
	const busyRef = useRef(false);
	const { closeSettings } = useSettings();
	const [section, setSection] = useState<SettingsSection>("appearance");
	const [compactionBusy, setCompactionBusy] = useState(false);
	const [providerBusy, setProviderBusy] = useState(false);
	const busy = section === "llm-provider" ? providerBusy : section === "context-compaction" && compactionBusy;

	const close = () => {
		if (!busyRef.current) closeSettings();
	};

	useEffect(() => {
		busyRef.current = busy;
	}, [busy]);

	useEffect(() => {
		const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !busyRef.current) {
				event.preventDefault();
				closeSettings();
				return;
			}
			if (event.key !== "Tab") return;
			const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
				'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
			);
			if (!focusable || focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first?.focus();
			}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			previousFocus?.focus();
		};
	}, [closeSettings]);

	const switchSection = (nextSection: SettingsSection) => {
		if (busyRef.current || nextSection === section) return;
		setCompactionBusy(false);
		setProviderBusy(false);
		setSection(nextSection);
	};

	return (
		<div
			className="management-dialog-backdrop"
			role="presentation"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) close();
			}}
		>
			<div ref={dialogRef} className="settings-dialog relative" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title">
				<aside className="settings-dialog-sidebar">
					<div className="flex items-center gap-2.5 px-3 pb-6 pt-1">
						<span className="grid h-8 w-8 place-items-center rounded-[10px] bg-[var(--accent-soft)] text-[var(--accent-ink)]"><Settings2 size={16} /></span>
						<h2 id="settings-dialog-title" className="text-[14px] font-semibold tracking-[-0.02em] text-[var(--ink)]">{intl.formatMessage({ id: "settings.title" })}</h2>
					</div>
					<nav className="space-y-1" aria-label={intl.formatMessage({ id: "settings.categories" })}>
						<button
							type="button"
							className="settings-nav-item"
							data-active={section === "appearance" ? "true" : "false"}
							aria-current={section === "appearance" ? "page" : undefined}
							disabled={busy}
							onClick={() => switchSection("appearance")}
						>
							<Palette size={15} />{intl.formatMessage({ id: "settings.appearance.title" })}
						</button>
						<button
							type="button"
							className="settings-nav-item"
							data-active={section === "context-compaction" ? "true" : "false"}
							aria-current={section === "context-compaction" ? "page" : undefined}
							disabled={busy}
							onClick={() => switchSection("context-compaction")}
						>
							<Shrink size={15} />{intl.formatMessage({ id: "settings.compaction.title" })}
						</button>
						<button
							type="button"
							className="settings-nav-item"
							data-active={section === "llm-provider" ? "true" : "false"}
							aria-current={section === "llm-provider" ? "page" : undefined}
							disabled={busy}
							onClick={() => switchSection("llm-provider")}
						>
							<Bot size={15} />{intl.formatMessage({ id: "provider.title" })}
						</button>
					</nav>
				</aside>

				{section === "appearance" ? (
					<SettingsSectionPanel
						title={intl.formatMessage({ id: "settings.appearance.title" })}
						description={intl.formatMessage({ id: "settings.appearance.description" })}
						closeDisabled={false}
						onClose={close}
					>
						<div className="space-y-8">
							<ThemeSelector />
							<div className="border-t border-[var(--line-soft)] pt-7"><LanguageSelector /></div>
						</div>
					</SettingsSectionPanel>
				) : section === "context-compaction" ? (
					<ContextCompactionSettings onClose={close} onBusyChange={setCompactionBusy} />
				) : (
					<LlmProviderSettings onClose={close} onBusyChange={setProviderBusy} />
				)}
			</div>
		</div>
	);
}
