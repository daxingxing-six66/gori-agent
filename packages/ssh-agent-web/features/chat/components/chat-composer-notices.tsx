"use client";

import { useIntl } from "react-intl";
import { NoticeCard } from "@/components/notice-card";
import type { ManualChatCompactionResult } from "@/features/chat/model/chat";
import { useLocalizedErrorMessage } from "@/features/i18n/components/use-localized-error-message";

export function ChatComposerNotices({
	runtimeError,
	autoAuditError,
	compacting,
	manualCompactionResult,
	onClearRuntimeError,
	onClearAutoAuditError,
	onClearManualCompactionResult,
}: {
	runtimeError: string | null;
	autoAuditError: unknown;
	compacting: boolean;
	manualCompactionResult: ManualChatCompactionResult | null;
	onClearRuntimeError(): void;
	onClearAutoAuditError(): void;
	onClearManualCompactionResult(): void;
}) {
	const intl = useIntl();
	const localizedErrorMessage = useLocalizedErrorMessage();
	if (!runtimeError && !autoAuditError && !compacting && !manualCompactionResult) return null;

	let compactionMessage: string | null = null;
	if (!compacting && manualCompactionResult) {
		if (manualCompactionResult.status === "completed") {
			compactionMessage = intl.formatMessage({ id: "chat.compaction.completed" }, {
				percent: manualCompactionResult.reductionPercent,
				before: manualCompactionResult.tokensBefore,
				after: manualCompactionResult.estimatedTokensAfter,
			});
			if (manualCompactionResult.model.fallback) {
				compactionMessage += `\n${intl.formatMessage({ id: "chat.compaction.fallback" })}`;
			}
		} else {
			compactionMessage = intl.formatMessage({ id: "chat.compaction.skipped" });
		}
	}

	return (
		<div className="mb-2.5 flex flex-col gap-2">
			{compacting ? <NoticeCard tone="info" loading message={intl.formatMessage({ id: "chat.compaction.inProgress" })} /> : null}
			{runtimeError ? <NoticeCard tone="error" message={runtimeError} onDismiss={onClearRuntimeError} /> : null}
			{autoAuditError ? <NoticeCard tone="error" message={localizedErrorMessage(autoAuditError)} onDismiss={onClearAutoAuditError} /> : null}
			{compactionMessage ? <NoticeCard tone="info" message={compactionMessage} onDismiss={onClearManualCompactionResult} /> : null}
		</div>
	);
}
