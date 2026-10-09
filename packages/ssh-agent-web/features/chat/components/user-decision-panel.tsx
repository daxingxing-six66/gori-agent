"use client";

import { ArrowRight, Check, ChevronLeft, ChevronRight, Pencil, SkipForward, Sparkles, X } from "lucide-react";
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
	const headingRef = useRef<HTMLHeadingElement>(null);
	const customInputRef = useRef<HTMLTextAreaElement>(null);
	const submitRef = useRef<HTMLButtonElement>(null);
	const [index, setIndex] = useState(0);
	const [answers, setAnswers] = useState<Array<UserDecisionAnswer | null>>(() => decision.questions.map(() => null));
	const question = decision.questions[index]!;
	const current = answers[index];
	const lastQuestion = index === decision.questions.length - 1;
	const currentComplete = isCompleteAnswer(current);
	const answered = answers.filter(isCompleteAnswer).length;
	const complete = answered === decision.questions.length;
	const customSelected = current?.kind === "custom";

	useEffect(() => { if (open) headingRef.current?.focus(); }, [index, open]);

	const updateAnswer = (answer: UserDecisionAnswer) => {
		setAnswers((previous) => previous.map((value, position) => position === index ? answer : value));
	};
	const chooseAndAdvance = (answer: UserDecisionAnswer) => {
		if (busy) return;
		updateAnswer(answer);
		if (!lastQuestion) setIndex(index + 1);
	};
	const activateCustom = () => {
		if (busy) return;
		if (!customSelected) updateAnswer({ kind: "custom", text: "" });
		requestAnimationFrame(() => customInputRef.current?.focus());
	};
	const advanceCustom = () => {
		if (!currentComplete || busy) return;
		if (lastQuestion) submitRef.current?.focus();
		else setIndex(index + 1);
	};
	const submit = async () => {
		const completed = answers.filter((answer): answer is UserDecisionAnswer => answer !== null);
		if (!lastQuestion || !complete || completed.length !== decision.questions.length || busy) return;
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
		<section role="region" aria-labelledby={`${groupId}-title`} onKeyDown={handleKeyDown}
			className="user-decision-panel absolute inset-x-0 bottom-[calc(100%+10px)] z-30 flex max-h-[min(62dvh,550px)] w-full flex-col overflow-hidden rounded-[18px] border border-line bg-surface-raised shadow-[0_-12px_42px_rgb(24_26_23/12%)]">
			<header className="shrink-0 border-b border-line-soft px-4 pb-3 pt-3 sm:px-5">
				<div className="mb-2 flex items-center justify-between gap-3">
					<div role="progressbar" aria-label={intl.formatMessage({ id: "chat.decision.answered" }, { answered, total: decision.questions.length })}
						aria-valuemin={0} aria-valuemax={decision.questions.length} aria-valuenow={answered}
						className={decision.questions.length <= 8 ? "decision-progress-steps" : "decision-progress-track"}>
						{decision.questions.length <= 8
							? decision.questions.map((_, position) => <span key={position} aria-hidden="true" className={isCompleteAnswer(answers[position] ?? null) ? "is-complete" : position === index ? "is-current" : ""} />)
							: <span style={{ width: `${answered / decision.questions.length * 100}%` }} />}
					</div>
					<span className="sr-only">{intl.formatMessage({ id: "chat.decision.position" }, { current: index + 1, total: decision.questions.length })}</span>
					<div className="flex items-center gap-1">
						<button type="button" disabled={index === 0 || busy} onClick={() => setIndex(index - 1)} className="decision-icon-button" aria-label={intl.formatMessage({ id: "chat.decision.previous" })} title={intl.formatMessage({ id: "chat.decision.previous" })}><ChevronLeft size={16} aria-hidden="true" /></button>
						{!lastQuestion ? <button type="button" disabled={!currentComplete || busy} onClick={() => setIndex(index + 1)} className="decision-icon-button" aria-label={intl.formatMessage({ id: "chat.decision.next" })} title={intl.formatMessage({ id: "chat.decision.next" })}><ChevronRight size={16} aria-hidden="true" /></button> : null}
						<button type="button" disabled={busy} onClick={onClose} className="decision-icon-button" aria-label={intl.formatMessage({ id: "chat.decision.close" })} title={intl.formatMessage({ id: "chat.decision.close" })}><X size={16} aria-hidden="true" /></button>
					</div>
				</div>
				<h2 ref={headingRef} tabIndex={-1} id={`${groupId}-title`} className="text-[15px] font-semibold leading-6 text-ink outline-none sm:text-base">{question.question}</h2>
			</header>
			<div className="app-scrollbar min-h-0 space-y-1 overflow-y-auto p-2 sm:p-3" role="group" aria-label={question.question}>
				{question.options.map((option, optionIndex) => {
					const selected = current?.kind === "option" && current.optionIndex === optionIndex;
					return <button key={optionIndex} type="button" aria-pressed={selected} disabled={busy}
						onClick={() => chooseAndAdvance({ kind: "option", optionIndex })}
						className={`decision-option ${selected ? "decision-option-selected" : ""}`}>
						<span aria-hidden="true" className="decision-choice-mark">{selected ? <Check size={12} strokeWidth={2.5} /> : null}</span>
						<span className="min-w-0 flex-1">
							<span className="flex items-center gap-1.5 text-[13px] font-semibold leading-5 text-ink">{option.label}{question.recommendedIndex === optionIndex ? <span role="img" aria-label={intl.formatMessage({ id: "chat.decision.recommended" })} title={intl.formatMessage({ id: "chat.decision.recommended" })} className="inline-flex shrink-0 text-accent"><Sparkles size={13} aria-hidden="true" /></span> : null}</span>
							<span className="mt-0.5 block whitespace-pre-wrap text-xs leading-[1.5] text-secondary">{option.description}</span>
						</span>
					</button>;
				})}
				<div className={`decision-custom ${customSelected ? "decision-custom-active" : ""}`}>
					<button type="button" disabled={busy} onClick={activateCustom} aria-expanded={customSelected} className="decision-custom-trigger">
						<Pencil size={15} aria-hidden="true" />
						<span>{intl.formatMessage({ id: "chat.decision.custom" })}</span>
					</button>
					{customSelected ? <div className="decision-custom-editor">
						<textarea ref={customInputRef} rows={2} maxLength={4_000} value={current.text}
							onChange={(event) => updateAnswer({ kind: "custom", text: event.target.value })} disabled={busy}
							onKeyDown={(event) => {
							if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
							event.preventDefault();
							advanceCustom();
						}}
							placeholder={intl.formatMessage({ id: "chat.decision.custom.placeholder" })}
							aria-label={intl.formatMessage({ id: "chat.decision.custom" })}
							aria-describedby={`${groupId}-custom-hint`}
							className="app-scrollbar min-w-0 flex-1 resize-none bg-transparent text-[13px] leading-5 text-ink outline-none placeholder:text-muted" />
						<span id={`${groupId}-custom-hint`} className="sr-only">{intl.formatMessage({ id: "chat.decision.custom.hint" })}</span>
						{!lastQuestion ? <button type="button" disabled={!currentComplete || busy} onClick={advanceCustom} className="decision-custom-advance" aria-label={intl.formatMessage({ id: "chat.decision.next" })} title={intl.formatMessage({ id: "chat.decision.next" })}><ArrowRight size={15} aria-hidden="true" /></button> : null}
					</div> : null}
				</div>
			</div>
			<footer className="flex shrink-0 items-center justify-between gap-2 border-t border-line-soft px-3 py-2 sm:px-4">
				<button type="button" disabled={busy} aria-pressed={current?.kind === "skipped"} onClick={() => chooseAndAdvance({ kind: "skipped" })}
					className={`decision-icon-button ${current?.kind === "skipped" ? "text-accent" : ""}`}
					aria-label={intl.formatMessage({ id: current?.kind === "skipped" ? "chat.decision.skipped" : "chat.decision.skip" })}
					title={intl.formatMessage({ id: current?.kind === "skipped" ? "chat.decision.skipped" : "chat.decision.skip" })}><SkipForward size={17} aria-hidden="true" /></button>
				{lastQuestion && complete ? <button ref={submitRef} type="button" disabled={busy} onClick={() => void submit()}
					className="inline-flex min-h-8 items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-xs font-semibold text-[var(--text-inverse)] transition hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-wait disabled:opacity-60">
					{busy ? intl.formatMessage({ id: "chat.decision.submitting" }) : intl.formatMessage({ id: "chat.decision.submit" })}<ArrowRight size={14} aria-hidden="true" />
				</button> : null}
				{error ? <p role="alert" className="w-full text-xs text-danger">{error}</p> : null}
			</footer>
		</section>
	);
}

function isCompleteAnswer(answer: UserDecisionAnswer | null): answer is UserDecisionAnswer {
	return answer !== null && (answer.kind !== "custom" || answer.text.trim().length > 0);
}
