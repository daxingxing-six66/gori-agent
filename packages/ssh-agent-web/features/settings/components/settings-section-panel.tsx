"use client";

import { ArrowLeft, X } from "lucide-react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";

export function SettingsSectionPanel({
	title,
	description,
	closeDisabled,
	onBack,
	onClose,
	children,
}: {
	title: string;
	description: string;
	closeDisabled: boolean;
	onBack?: () => void;
	onClose(): void;
	children: ReactNode;
}) {
	const intl = useIntl();
	return (
		<section className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--surface-raised)]">
			<header className="flex items-start justify-between gap-6 border-b border-[var(--line-soft)] px-7 py-5">
				<div className="flex min-w-0 items-start gap-2.5">
					{onBack ? (
						<button
							type="button"
							className="mt-0.5 rounded-lg p-1.5 text-[var(--text-faint)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)] disabled:opacity-40"
							disabled={closeDisabled}
							onClick={onBack}
							aria-label={intl.formatMessage({ id: "settings.provider.back" })}
						>
							<ArrowLeft size={16} />
						</button>
					) : null}
					<div className="min-w-0">
						<p className="text-[15px] font-semibold tracking-[-0.02em] text-[var(--ink)]">{title}</p>
						<p className="mt-1.5 max-w-[520px] text-[10px] leading-5 text-[var(--text-muted)]">{description}</p>
					</div>
				</div>
				<button
					type="button"
					autoFocus
					className="rounded-lg p-2 text-[var(--text-faint)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-40"
					disabled={closeDisabled}
					onClick={onClose}
					aria-label={intl.formatMessage({ id: "settings.close" })}
				>
					<X size={17} />
				</button>
			</header>
			<div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-7 py-6">{children}</div>
		</section>
	);
}
