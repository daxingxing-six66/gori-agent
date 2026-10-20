import { useIntl } from "react-intl";
import type { DiagnoseNodeStatus, DiagnoseStatus } from "../model/diagnose";

export function DiagnoseStatusBadge({ status }: { status: DiagnoseNodeStatus | DiagnoseStatus }) {
	const intl = useIntl();
	const id = status === "active" || status === "completed" || status === "cancelled" ? `diagnose.status.${status}` as const : `diagnose.node.${status}` as const;
	return <span className="diagnose-status" data-status={status}>{intl.formatMessage({ id })}</span>;
}
