"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import {
	ThinkingLevelSlider,
	thinkingLevelMessageId,
} from "@/features/llm-provider/components/thinking-level-slider";
import type { ThinkingLevel } from "@/features/llm-provider/model/llm-provider";

export function ThinkingLevelSelector({ levels, value, modelName, disabled = false, appearance = "default", onChange }: {
	levels: readonly ThinkingLevel[];
	value: ThinkingLevel;
	modelName?: string;
	disabled?: boolean;
	appearance?: "default" | "composer";
	onChange(level: ThinkingLevel): void;
}) {
	const intl = useIntl();
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const closeOnOutsidePointer = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", closeOnOutsidePointer);
		return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
	}, [open]);

	if (levels.length <= 1) return null;

	return (
		<div ref={rootRef} className="relative">
			<button
				type="button"
				className={`model-selector-trigger flex h-7 items-center rounded-md text-zinc-500 transition hover:text-zinc-700 disabled:cursor-default disabled:hover:text-zinc-500 ${appearance === "composer" ? "gap-1 px-1.5 pr-2 text-[10px] font-medium" : "px-1.5"}`}
				aria-haspopup="listbox"
				aria-expanded={open}
				disabled={disabled}
				onClick={() => setOpen((current) => !current)}
			>
				<span>{intl.formatMessage({ id: thinkingLevelMessageId(value) })}</span>{appearance === "composer" && !disabled ? <ChevronDown size={10} strokeWidth={1.8} className={`shrink-0 transition ${open ? "rotate-180" : ""}`} /> : null}
			</button>
			{open ? <ThinkingLevelSlider levels={levels} value={value} modelName={modelName} onChange={onChange} /> : null}
		</div>
	);
}
