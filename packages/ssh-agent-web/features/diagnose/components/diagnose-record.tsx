import { ChevronDown } from "lucide-react";
import { useIntl } from "react-intl";
import type { DiagnoseNode } from "../model/diagnose";
import { DiagnoseMarkdown } from "./diagnose-markdown";
import { DiagnoseStatusBadge } from "./diagnose-status-badge";

export function DiagnoseRecord({ node, expanded, current, onToggle }: { node: DiagnoseNode; expanded: boolean; current: boolean; onToggle(): void }) {
	const intl = useIntl();
	const id = `diagnose-${node.taskId}-${node.sequence}`;
	return <section className="diagnose-record" data-current={current} data-sequence={node.sequence}>
		<button type="button" className="diagnose-record-heading" aria-expanded={expanded} aria-controls={id} onClick={onToggle}>
			<span className="diagnose-sequence" aria-hidden="true">{String(node.sequence).padStart(2, "0")}</span>
			<span className="diagnose-direction">{node.direction}</span><DiagnoseStatusBadge status={node.status} />
			<ChevronDown size={14} className={expanded ? "diagnose-chevron-open" : ""} aria-hidden="true" />
		</button>
		<div id={id} hidden={!expanded} className="diagnose-explanation">{node.explanation ? <DiagnoseMarkdown content={node.explanation} /> : <p className="diagnose-muted">{intl.formatMessage({ id: "diagnose.noExplanation" })}</p>}</div>
		{!expanded ? <p className="diagnose-preview">{node.explanation.split(/\r?\n/u).find((line) => line.trim()) ?? intl.formatMessage({ id: "diagnose.noExplanation" })}</p> : null}
	</section>;
}
