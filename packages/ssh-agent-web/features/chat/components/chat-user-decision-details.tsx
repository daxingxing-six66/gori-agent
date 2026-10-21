"use client";

import { useIntl } from "react-intl";
import { isRecord } from "@/features/chat/model/chat";
import type { UserDecisionOption } from "@/features/chat/model/user-decision";
import { ChatMarkdown } from "./chat-markdown";
import type { ToolDetailsProps } from "./chat-tool-details";

type HistoryAnswer =
	| { kind: "option"; option: UserDecisionOption }
	| { kind: "custom"; text: string }
	| { kind: "skipped" };

function readQuestions(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const questions: string[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || !nonemptyText(entry.question)) return null;
		questions.push(entry.question);
	}
	return questions;
}

/** The tool result includes each question so an answer is never paired by position alone. */
function readAnswers(output: string, questions: string[]): HistoryAnswer[] | null {
	let result: unknown;
	try { result = JSON.parse(output); } catch { return null; }
	if (!isRecord(result) || !Array.isArray(result.answers) || result.answers.length !== questions.length) return null;
	const answers: HistoryAnswer[] = [];
	for (const [index, answer] of result.answers.entries()) {
		if (!isRecord(answer) || typeof answer.question !== "string" || answer.question.trim() !== questions[index]!.trim()) return null;
		if (answer.kind === "skipped") answers.push({ kind: "skipped" });
		else if (answer.kind === "custom" && nonemptyText(answer.text)) answers.push({ kind: "custom", text: answer.text });
		else if (answer.kind === "option" && isRecord(answer.option) && nonemptyText(answer.option.label) && nonemptyText(answer.option.description)) {
			answers.push({ kind: "option", option: { label: answer.option.label, description: answer.option.description } });
		} else return null;
	}
	return answers;
}

function nonemptyText(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function UserDecisionDetails({ call, execution, argumentsText, output, failed, children }: ToolDetailsProps) {
	const intl = useIntl();
	const questions = readQuestions(call.arguments.questions);
	// Incomplete or invalid requests keep their diagnostics rather than inventing a question or answer.
	const answers = questions && !failed ? readAnswers(output, questions) : null;
	const waiting = !execution || execution.status === "waiting" || execution.status === "running";
	return <div className="min-w-0 [overflow-wrap:anywhere]">
		{questions ? <ol className="mt-3 space-y-4">
			{questions.map((question, index) => <li key={index} className="min-w-0 border-t border-line-soft pt-3 first:border-t-0 first:pt-0">
				<p className="mb-1.5 text-[11px] font-medium text-muted">{intl.formatMessage({ id: "chat.decision.history.question" }, { number: index + 1 })}</p>
				<div className="text-sm text-ink"><ChatMarkdown>{question}</ChatMarkdown></div>
				<div className="mt-3 rounded-lg border border-line-soft bg-surface px-3 py-2.5">
					<p className="mb-1.5 text-[11px] font-medium text-accent">{intl.formatMessage({ id: "chat.decision.history.answer" })}</p>
					{answers ? <DecisionAnswer answer={answers[index]!} /> : <p className="text-xs leading-5 text-muted">{intl.formatMessage({ id: waiting ? "chat.decision.history.waiting" : "chat.decision.history.unavailable" })}</p>}
				</div>
			</li>)}
		</ol> : <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-ink">{argumentsText}</pre>}
		{children}
		{output && !answers ? <DecisionOutput output={output} failed={failed} /> : null}
	</div>;
}

function DecisionOutput({ output, failed }: { output: string; failed: boolean }) {
	const intl = useIntl();
	if (failed) return <pre role="alert" className="app-scrollbar mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-line-soft pt-3 font-mono text-xs leading-5 text-danger">{output}</pre>;
	return <details className="mt-3 border-t border-line-soft pt-3 text-secondary">
		<summary className="cursor-pointer text-xs">{intl.formatMessage({ id: "chat.tool.command.output" })}</summary>
		<pre className="app-scrollbar mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5">{output}</pre>
	</details>;
}

function DecisionAnswer({ answer }: { answer: HistoryAnswer }) {
	const intl = useIntl();
	if (answer.kind === "skipped") return <p className="text-xs leading-5 text-muted">{intl.formatMessage({ id: "chat.decision.skipped" })}</p>;
	if (answer.kind === "custom") return <ChatMarkdown>{answer.text}</ChatMarkdown>;
	return <div>
		<p className="mb-1 whitespace-pre-wrap text-sm font-medium leading-6 text-ink">{answer.option.label}</p>
		<ChatMarkdown subtle>{answer.option.description}</ChatMarkdown>
	</div>;
}
