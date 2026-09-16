import type { ChatRun } from "@/features/chat/model/chat";

export function ChatFailureDetails({ failure, fallback }: { failure: ChatRun["failure"]; fallback: string }) {
	return <>
		<p className="mt-1 leading-5">{failure?.message ?? fallback}</p>
		{failure?.recovery ? <p className="mt-1 leading-5">{failure.recovery.message}</p> : null}
		{failure?.errorId ? <p className="mt-1 break-all font-mono">{failure.errorId}</p> : null}
	</>;
}
