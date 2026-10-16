import type { MessageId } from "@/features/i18n/messages/zh-CN";
import { enUSCommonMessages } from "@/features/i18n/messages/en-US/common";
import { enUSSettingsMessages } from "@/features/i18n/messages/en-US/settings";
import { enUSWorkspaceMessages } from "@/features/i18n/messages/en-US/workspace";
import { enUSSessionMessages } from "@/features/i18n/messages/en-US/session";
import { enUSChatMessages } from "@/features/i18n/messages/en-US/chat";
import { enUSGuardMessages } from "@/features/i18n/messages/en-US/guard";
import { enUSProviderMessages } from "@/features/i18n/messages/en-US/provider";
import { enUSSftpMessages } from "@/features/i18n/messages/en-US/sftp";
import { enUSTerminalMessages } from "@/features/i18n/messages/en-US/terminal";
import { enUSServerMetricsMessages } from "@/features/i18n/messages/en-US/server-metrics";
import { enUSTaskContainerMessages } from "@/features/i18n/messages/en-US/task-container";
import { enUSStatisticsMessages } from "@/features/i18n/messages/en-US/statistics";
import { enUSDeployTaskMessages } from "@/features/i18n/messages/en-US/deploy-task";

export const enUSMessages = {
	...enUSCommonMessages,
	...enUSSettingsMessages,
	...enUSWorkspaceMessages,
	...enUSSessionMessages,
	...enUSChatMessages,
	...enUSGuardMessages,
	...enUSProviderMessages,
	...enUSSftpMessages,
	...enUSTerminalMessages,
	...enUSServerMetricsMessages,
	...enUSTaskContainerMessages,
	...enUSStatisticsMessages,
	...enUSDeployTaskMessages,
} satisfies Record<MessageId, string>;
