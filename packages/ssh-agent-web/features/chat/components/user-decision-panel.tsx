"use client";

import { ArrowRight, ChevronLeft, ChevronRight, Pencil, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useIntl } from "react-intl";
import type { UserDecision, UserDecisionAnswer } from "@/features/chat/model/user-decision";

export function UserDecisionPanel({ decision, open, busy, error, onClose, onSubmit }: {
	decision: UserDecision;
	open: boolean;
	busy: boolean;
	error: string | null;
	onClose(): void;
	onSubmit(answers: UserDecisionAnswer[]): Promise<boolean>;
}) {
	const intl = useIntl();
	const groupId = useId();
	const panelRef = useRef<HTMLElement>(null);
	const [index, setIndex] = useState(0);
	const [answers, setAnswers] = useState<Array<UserDecisionAnswer | null>>(() => decision.questions.map(() => null));
	const question = decision.questions[index]!;
	const current = answers[index];
	const complete = answers.every((answer) => answer !== null && (answer.kind !== "custom" || answer.text.trim().length > 0));

	useEffect(() => {
		if (open) panelRef.current?.focus();
	}, [open]);

	const select = (answer: UserDecisionAnswer, advance = false) => {
		setAnswers((previous) => previous.map((value, position) => position === index ? answer : value));
		if (advance && index < decision.questions.length - 1) setIndex(index + 1);
	};
	const submit = async () => {
		const completed = answers.filter((answer): answer is UserDecisionAnswer => answer !== null);
		if (!complete || completed.length !== decision.questions.length || busy) return;
		await onSubmit(completed);
	};
	const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
		if (event.key !== "Escape" || busy) return;
		event.preventDefault();
		event.stopPropagation();
		onClose();
	};

	if (!open) return null;
	return (
		<section ref={panelRef} role="region" aria-labelledby={`${groupId}-title`} tabIndex={-1}
			onKeyDown={handleKeyDown}
			className="user-decision-panel absolute inset-x-0 bottom-[calc(100%+12px)] z-30 flex max-h-[min(55dvh,520px)] w-full flex-col overflow-hidden rounded-[20px] border border-zinc-200 bg-white shadow-[0_-14px_48px_rgb(24_26_23/12%)] outline-none">
			<div className="flex shrink-0 flex-col gap-2 px-4 pb-3 pt-4 sm:flex-row sm:items-start sm:gap-3 sm:px-6 sm:pt-5">
				<h2 id={`${groupId}-title`} className="min-w-0 flex-1 text-lg font-semibold leading-7 text-zinc-900 sm:text-xl">{question.question}</h2>
				<div className="flex shrink-0 self-end items-center gap-1 text-sm text-zinc-500">
					<button type="button" disabled={index === 0 || busy} onClick={() => setIndex(index - 1)} className="grid h-8 w-8 place-items-center rounded-lg hover:bg-zinc-100 disabled:opacity-30" aria-label={intl.formatMessage({ id: "chat.decision.previous" })}><ChevronLeft size={18} /></button>
					<span className="min-w-16 text-center tabular-nums">{intl.formatMessage({ id: "chat.decision.position" }, { current: index + 1, total: decision.questions.length })}</span>
					<button type="button" disabled={index === decision.questions.length - 1 || !current || (current.kind === "custom" && !current.text.trim()) || busy} onClick={() => setIndex(index + 1)} className="grid h-8 w-8 place-items-center rounded-lg hover:bg-zinc-100 disabled:opacity-30" aria-label={intl.formatMessage({ id: "chat.decision.next" })}><ChevronRight size={18} /></button>
					<button type="button" disabled={busy} onClick={onClose} className="ml-1 grid h-8 w-8 place-items-center rounded-lg hover:bg-zinc-100 disabled:opacity-30" aria-label={intl.formatMessage({ id: "chat.decision.close" })}><X size={18} /></button>
				</div>
			</div>
			<div className="app-scrollbar min-h-0 overflow-y-auto px-4 pb-3 sm:px-6" role="radiogroup" aria-label={question.question}>
				{question.options.map((option, optionIndex) => {
					const selected = current?.kind === "option" && current.optionIndex === optionIndex;
					return <label key={optionIndex} className={`mb-2 flex cursor-pointer items-start gap-3 rounded-2xl border px-3 py-3 transition sm:px-4 ${selected ? "border-zinc-300 bg-zinc-100" : "border-transparent hover:bg-zinc-50"}`}>
						<input className="peer sr-only" type="radio" name={`${groupId}-${index}`} checked={selected} onChange={() => select({ kind: "option", optionIndex }, true)} disabled={busy} />
						<span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-zinc-200 bg-zinc-100 text-sm text-zinc-500 peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-500">{optionIndex + 1}</span>
						<span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-900 sm:text-base">{option.label}{question.recommendedIndex === optionIndex ? <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-600">{intl.formatMessage({ id: "chat.decision.recommended" })}</span> : null}</span><span className="mt-1 block whitespace-pre-wrap text-sm leading-5 text-zinc-500">{option.description}</span></span>
						{selected ? <ArrowRight className="mt-2 shrink-0 text-zinc-500" size={18} /> : null}
					</label>;
				})}
				<label className={`flex items-start gap-3 rounded-2xl border px-3 py-3 sm:px-4 ${current?.kind === "custom" ? "border-emerald-300 bg-emerald-50/50" : "border-transparent hover:bg-zinc-50"}`}>
					<input className="peer sr-only" type="radio" name={`${groupId}-${index}`} checked={current?.kind === "custom"} onChange={() => select({ kind: "custom", text: current?.kind === "custom" ? current.text : "" })} disabled={busy} />
					<span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-zinc-200 bg-zinc-100 text-zinc-500 peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-500"><Pencil size={16} /></span>
					<textarea rows={2} maxLength={4_000} value={current?.kind === "custom" ? current.text : ""} onFocus={() => { if (current?.kind !== "custom") select({ kind: "custom", text: "" }); }} onChange={(event) => select({ kind: "custom", text: event.target.value })} disabled={busy} placeholder={intl.formatMessage({ id: "chat.decision.custom" })} aria-label={intl.formatMessage({ id: "chat.decision.custom" })} className="min-w-0 flex-1 resize-none bg-transparent pt-1 text-sm text-zinc-800 outline-none placeholder:text-zinc-400" />
				</label>
			</div>
			<div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-zinc-100 px-4 py-3 sm:px-6">
				<button type="button" disabled={busy} aria-pressed={current?.kind === "skipped"} onClick={() => select({ kind: "skipped" }, true)} className={`rounded-lg px-3 py-2 text-sm font-medium hover:bg-zinc-100 disabled:opacity-40 ${current?.kind === "skipped" ? "bg-zinc-100 text-zinc-900" : "text-zinc-600"}`}>{intl.formatMessage({ id: current?.kind === "skipped" ? "chat.decision.skipped" : "chat.decision.skip" })}</button>
				<div className="flex items-center gap-3">{error ? <span role="alert" className="max-w-48 text-right text-xs text-rose-600">{error}</span> : null}<button type="button" disabled={!complete || busy} onClick={() => void submit()} className="rounded-xl bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-40">{intl.formatMessage({ id: busy ? "chat.decision.submitting" : "chat.decision.submit" })}</button></div>
			</div>
		</section>
	);
}
