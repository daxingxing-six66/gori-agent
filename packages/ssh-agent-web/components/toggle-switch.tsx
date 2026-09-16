"use client";

interface ToggleSwitchProps {
	checked: boolean;
	disabled?: boolean;
	label: string;
	pending?: boolean;
	onChange(checked: boolean): void;
}

export function ToggleSwitch({ checked, disabled = false, label, pending = false, onChange }: ToggleSwitchProps) {
	return (
		<span className="relative inline-flex shrink-0">
			<button
				type="button"
				role="switch"
				aria-checked={checked}
				aria-label={label}
				aria-busy={pending}
				disabled={disabled || pending}
				onClick={() => onChange(!checked)}
				className={`toggle-switch relative inline-flex h-[18px] w-[34px] shrink-0 rounded-full border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8bc8ad] focus-visible:ring-offset-2 disabled:cursor-not-allowed ${disabled && !pending ? "opacity-45" : ""} ${checked ? "border-[#397b5c] bg-[#397b5c]" : "border-zinc-300 bg-zinc-200"}`}
			>
				<span className="toggle-switch-knob absolute left-px top-px h-[14px] w-[14px] rounded-full bg-white shadow-[0_1px_2px_rgb(24_24_27/20%)]" />
			</button>
			<span aria-hidden="true" className={`pointer-events-none absolute -inset-0.5 rounded-full bg-white/55 backdrop-blur-[1px] transition-opacity duration-150 ${pending ? "opacity-100" : "opacity-0"}`} />
		</span>
	);
}
