"use client";

import { useIntl } from "react-intl";
import type { MessageId } from "@/features/i18n/messages/zh-CN";
import type { ThinkingLevel } from "@/features/llm-provider/model/llm-provider";

const labelIds: Record<ThinkingLevel, MessageId> = {
	off: "provider.thinking.off",
	minimal: "provider.thinking.minimal",
	low: "provider.thinking.low",
	medium: "provider.thinking.medium",
	high: "provider.thinking.high",
	xhigh: "provider.thinking.xhigh",
	max: "provider.thinking.max",
};

export function thinkingLevelMessageId(level: ThinkingLevel): MessageId {
	return labelIds[level];
}

export function ThinkingLevelSlider({ levels, value, modelName, onChange }: {
	levels: readonly ThinkingLevel[];
	value: ThinkingLevel;
	modelName?: string;
	onChange(level: ThinkingLevel): void;
}) {
	const intl = useIntl();
	const selectedIndex = Math.max(levels.indexOf(value), 0);
	const selectedProgress = (selectedIndex / Math.max(levels.length - 1, 1)) * 100;

	return (
		<div className="model-selector-popover absolute bottom-[calc(100%+8px)] right-0 z-50 w-[224px] max-w-[calc(100vw-32px)] rounded-2xl border border-[var(--line)] bg-white p-3 shadow-[0_14px_40px_rgb(15_23_42/14%)]" role="listbox" aria-label={intl.formatMessage({ id: "provider.thinking.select" })}>
			<div className="flex min-w-0 items-center gap-2 px-0.5 text-zinc-700">
				<span className="min-w-0 flex-1 truncate text-[10px] font-semibold tracking-[-0.01em]">{modelName ?? intl.formatMessage({ id: "provider.thinking.title" })}</span>
				<span className="text-[10px] font-semibold text-zinc-500">{intl.formatMessage({ id: labelIds[value] })}</span>
			</div>
			<div className="relative mt-3 h-7 overflow-hidden rounded-full bg-zinc-200">
				<span className="pointer-events-none absolute inset-y-0 left-0 rounded-full bg-[#4a86ee] transition-[width] duration-200" style={{ width: `${selectedProgress}%` }} />
				<div className="relative h-7">
					{levels.map((level, index) => {
						const selected = level === value;
						const position = (index / Math.max(levels.length - 1, 1)) * 100;
						const translate = index === 0 ? "translateX(0)" : index === levels.length - 1 ? "translateX(-100%)" : "translateX(-50%)";
						return (
							<button
								type="button"
								key={level}
								role="option"
								aria-label={intl.formatMessage({ id: labelIds[level] })}
								aria-selected={selected}
								title={intl.formatMessage({ id: labelIds[level] })}
								className="group absolute top-0 grid h-7 w-7 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#397b5c]/30 focus-visible:ring-inset"
								style={{ left: `${position}%`, transform: translate }}
								onClick={() => onChange(level)}
							>
								{selected ? <span className="h-7 w-7 rounded-full border border-zinc-200 bg-white shadow-[0_2px_6px_rgb(24_24_27/16%)]" /> : <span className="h-1 w-1 rounded-full bg-white/60 transition group-hover:scale-125 group-hover:bg-white" />}
							</button>
						);
					})}
				</div>
			</div>
		</div>
	);
}
