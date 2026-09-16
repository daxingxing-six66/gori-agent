import { ToggleSwitch } from "@/components/toggle-switch";

export function GuardRuleSwitch({ checked, disabled = false, label, pending = false, onChange }: {
	checked: boolean;
	disabled?: boolean;
	label: string;
	pending?: boolean;
	onChange(checked: boolean): void;
}) {
	return <ToggleSwitch checked={checked} disabled={disabled} label={label} pending={pending} onChange={onChange} />;
}
