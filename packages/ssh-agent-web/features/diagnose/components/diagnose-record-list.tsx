import { useIntl } from "react-intl";
import type { DiagnoseNode } from "../model/diagnose";
import { DiagnoseRecord } from "./diagnose-record";

export function DiagnoseRecordList({ nodes, currentSequence, expanded, onToggle }: { nodes: DiagnoseNode[]; currentSequence: number; expanded: Record<number, boolean>; onToggle(sequence: number): void }) {
	const intl = useIntl();
	if (!nodes.length) return <p className="diagnose-empty">{intl.formatMessage({ id: "diagnose.empty" })}</p>;
	return <div className="diagnose-records">{nodes.map((node) => <DiagnoseRecord key={node.sequence} node={node} current={node.sequence === currentSequence}
		expanded={expanded[node.sequence] ?? node.sequence === currentSequence} onToggle={() => onToggle(node.sequence)} />)}</div>;
}
