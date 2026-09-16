"use client";

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useIntl } from "react-intl";

export interface CustomSelectOption {
	value: string;
	label: string;
	description?: string;
	disabled?: boolean;
}

export function CustomSelect({
	ariaLabel,
	value,
	options,
	placeholder,
	onChange,
	disabled = false,
	compact = false,
}: {
	ariaLabel: string;
	value: string;
	options: CustomSelectOption[];
	placeholder?: string;
	onChange(value: string): void;
	disabled?: boolean;
	compact?: boolean;
}) {
	const intl = useIntl();
	const listboxId = useId();
	const rootRef = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const selectedIndex = options.findIndex((option) => option.value === value);
	const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;
	const firstEnabledIndex = options.findIndex((option) => !option.disabled);

	useEffect(() => {
		if (!open) return;
		const closeOnOutsidePointer = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", closeOnOutsidePointer);
		return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
	}, [open]);

	const openAtSelection = () => {
		setActiveIndex(selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : firstEnabledIndex);
		setOpen(true);
	};

	const selectActiveOption = () => {
		const option = options[activeIndex];
		if (!option || option.disabled) return;
		onChange(option.value);
		setOpen(false);
	};

	const moveActiveOption = (offset: number) => {
		if (firstEnabledIndex < 0) return;
		setActiveIndex((current) => {
			let candidate = current < 0 ? firstEnabledIndex : current;
			for (let index = 0; index < options.length; index += 1) {
				candidate = (candidate + offset + options.length) % options.length;
				if (!options[candidate]?.disabled) return candidate;
			}
			return firstEnabledIndex;
		});
	};

	return (
		<div ref={rootRef} className="custom-select">
			<button
				type="button"
				className={`custom-select-trigger ${compact ? "custom-select-trigger-compact" : ""}`}
				aria-label={ariaLabel}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={listboxId}
				disabled={disabled}
				onClick={() => open ? setOpen(false) : openAtSelection()}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						if (open) event.stopPropagation();
						setOpen(false);
						return;
					}
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						if (!open) {
							openAtSelection();
							return;
						}
						moveActiveOption(event.key === "ArrowDown" ? 1 : -1);
						return;
					}
					if (open && (event.key === "Enter" || event.key === " ")) {
						event.preventDefault();
						selectActiveOption();
					}
				}}
			>
				<span className={selectedOption ? "custom-select-value" : "custom-select-placeholder"}>{selectedOption?.label ?? placeholder ?? intl.formatMessage({ id: "common.select" })}</span>
				<ChevronDown className={`custom-select-chevron ${open ? "custom-select-chevron-open" : ""}`} size={15} />
			</button>
			{open ? (
				<div id={listboxId} className="custom-select-options app-scrollbar" role="listbox" aria-label={ariaLabel}>
					{options.map((option, index) => (
						<button
							type="button"
							key={option.value}
							role="option"
							aria-selected={option.value === value}
							aria-disabled={option.disabled}
							disabled={option.disabled}
							className={`custom-select-option ${index === activeIndex ? "custom-select-option-active" : ""} ${option.disabled ? "custom-select-option-disabled" : ""}`}
							onMouseEnter={() => { if (!option.disabled) setActiveIndex(index); }}
							onClick={() => {
								onChange(option.value);
								setOpen(false);
							}}
						>
							<span className="min-w-0 flex-1 text-left">
								<span className="block truncate">{option.label}</span>
								{option.description ? <span className="mt-0.5 block truncate text-[9px] font-normal text-zinc-400">{option.description}</span> : null}
							</span>
							<Check className={option.value === value ? "opacity-100" : "opacity-0"} size={14} />
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}
