"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import type { ChatContextUsage } from "@/features/chat/model/chat-context-usage";

export function ChatContextUsageIndicator({ usage }: { usage: ChatContextUsage | null }) {
	const intl = useIntl();
	const tooltipId = useId();
	const [open, setOpen] = useState(false);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const [position, setPosition] = useState({ left: 0, bottom: 0 });
	const show = () => {
		const rect = buttonRef.current?.getBoundingClientRect();
		if (!rect) return;
		const width = Math.min(240, window.innerWidth - 32);
		setPosition({ left: Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16)), bottom: window.innerHeight - rect.top });
		setOpen(true);
	};
	useEffect(() => {
		if (!open) return;
		const close = () => setOpen(false);
		window.addEventListener("resize", close);
		window.addEventListener("scroll", close, true);
		return () => {
			window.removeEventListener("resize", close);
			window.removeEventListener("scroll", close, true);
		};
	}, [open]);
	if (!usage) return null;
	const percent = intl.formatNumber(usage.usagePercent / 100, { style: "percent", maximumFractionDigits: 1 });
	const tokens = (value: number) => value >= 1000 ? `${intl.formatNumber(value / 1000, { maximumFractionDigits: 1 })}k` : intl.formatNumber(value);
	const label = intl.formatMessage({ id: "chat.contextUsage.used" }, { percent });
	return (
		<div className="relative shrink-0" onMouseEnter={show} onMouseLeave={() => setOpen(false)}>
			<button ref={buttonRef} type="button" className="grid h-7 w-7 place-items-center rounded-full text-[var(--muted)] hover:bg-[var(--surface-muted)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]" aria-label={`${intl.formatMessage({ id: "chat.contextUsage.title" })}: ${label}`} aria-describedby={open ? tooltipId : undefined} onFocus={show} onBlur={() => setOpen(false)} onClick={show} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
				<svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" className={usage.usagePercent >= 100 ? "text-[var(--danger)]" : usage.usagePercent >= 80 ? "text-[var(--warning)]" : "text-[var(--muted)]"}>
					<circle cx="10" cy="10" r="7" fill="none" stroke="var(--line)" strokeWidth="3" />
					<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="3" pathLength="100" strokeDasharray={`${Math.min(100, usage.usagePercent)} 100`} transform="rotate(-90 10 10)" />
				</svg>
			</button>
			{open ? createPortal(<div id={tooltipId} role="tooltip" style={position} className="fixed z-[70] w-60 max-w-[calc(100vw-32px)] pb-2" onMouseEnter={show} onMouseLeave={() => setOpen(false)}>
				<div className="rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] px-4 py-3 text-center text-[11px] leading-5 text-[var(--secondary)] shadow-[var(--shadow-raised)]">
					<p className="font-semibold">{intl.formatMessage({ id: "chat.contextUsage.title" })}</p>
					<p>{label}</p>
					<p className="text-[var(--ink)]">{intl.formatMessage({ id: "chat.contextUsage.tokens" }, { used: tokens(usage.contextTokens), total: tokens(usage.contextWindow) })}</p>
					<p className="mt-1 break-all text-[9px] text-[var(--muted)]">{usage.providerId} / {usage.modelId}</p>
				</div>
			</div>, document.body) : null}
		</div>
	);
}
