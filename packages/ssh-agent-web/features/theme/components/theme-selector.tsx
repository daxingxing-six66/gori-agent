"use client";

import { Check, Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useIntl } from "react-intl";
import type { MessageId } from "@/features/i18n/messages/zh-CN";
import { useTheme } from "@/features/theme/components/theme-context";
import type { ResolvedTheme, ThemePreference } from "@/features/theme/model/theme";

interface ThemeOption {
	value: ThemePreference;
	labelId: MessageId;
	descriptionId: MessageId;
	Icon: LucideIcon;
}
const THEME_OPTIONS: readonly ThemeOption[] = [
	{ value: "light", labelId: "theme.light.label", descriptionId: "theme.light.description", Icon: Sun },
	{ value: "dark", labelId: "theme.dark.label", descriptionId: "theme.dark.description", Icon: Moon },
	{ value: "system", labelId: "theme.system.label", descriptionId: "theme.system.description", Icon: Monitor },
];

export function ThemeSelector() {
	const { preference, resolvedTheme, setPreference } = useTheme();
	return (
		<ThemePreferenceControl
			preference={preference}
			resolvedTheme={resolvedTheme}
			onChange={setPreference}
		/>
	);
}

export function ThemePreferenceControl({
	preference,
	resolvedTheme,
	onChange,
}: {
	preference: ThemePreference;
	resolvedTheme: ResolvedTheme;
	onChange(value: ThemePreference): void;
}) {
	const intl = useIntl();
	return (
		<div className="theme-settings-panel">
			<div>
				<p className="text-[12px] font-semibold text-[var(--ink)]">{intl.formatMessage({ id: "theme.title" })}</p>
				<p className="mt-1.5 text-[10px] leading-5 text-[var(--text-muted)]">{intl.formatMessage({ id: "theme.description" })}</p>
			</div>
			<fieldset className="theme-options" aria-label={intl.formatMessage({ id: "theme.title" })}>
				{THEME_OPTIONS.map(({ value, labelId, descriptionId, Icon }) => {
					const selected = preference === value;
					const label = intl.formatMessage({ id: labelId });
					return (
						<label key={value} className="theme-option" data-selected={selected ? "true" : "false"}>
							<input
								type="radio"
								name="theme-preference"
								value={value}
								checked={selected}
								onChange={() => onChange(value)}
							/>
							<span className="theme-option-preview" data-preview={value === "system" ? resolvedTheme : value}>
								<span /><span /><span />
							</span>
							<span className="theme-option-copy">
								<span className="theme-option-title"><Icon size={14} />{label}{selected ? <Check size={13} className="theme-option-check" /> : null}</span>
								<span className="theme-option-description">{intl.formatMessage({ id: descriptionId })}</span>
								{value === "system" ? <span className="theme-option-resolution">{intl.formatMessage({ id: "theme.system.resolved" }, { theme: intl.formatMessage({ id: resolvedTheme === "dark" ? "theme.dark.label" : "theme.light.label" }) })}</span> : null}
							</span>
						</label>
					);
				})}
			</fieldset>
		</div>
	);
}
