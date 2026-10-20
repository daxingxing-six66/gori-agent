import { useIntl } from "react-intl";
import type { DiagnoseHistoryIdentity } from "../model/diagnose-history-entry";
import { DiagnoseStatusBadge } from "./diagnose-status-badge";
import "./diagnose-task.css";

export function DiagnoseHistoryCard({ identity, onOpen }: { identity: DiagnoseHistoryIdentity; onOpen(): void }) {
	const intl = useIntl();
	return <button type="button" className="diagnose-history-card" data-diagnose-id={identity.taskId} onClick={onOpen}><span className="diagnose-history-label">Diagnose</span><strong>{identity.title}</strong><DiagnoseStatusBadge status={identity.status} /><span>{intl.formatMessage({ id: "diagnose.history.open" })} →</span></button>;
}
