import { zhCNCommonMessages } from "@/features/i18n/messages/zh-CN/common";
import { zhCNSettingsMessages } from "@/features/i18n/messages/zh-CN/settings";
import { zhCNWorkspaceMessages } from "@/features/i18n/messages/zh-CN/workspace";
import { zhCNSessionMessages } from "@/features/i18n/messages/zh-CN/session";
import { zhCNChatMessages } from "@/features/i18n/messages/zh-CN/chat";
import { zhCNGuardMessages } from "@/features/i18n/messages/zh-CN/guard";
import { zhCNProviderMessages } from "@/features/i18n/messages/zh-CN/provider";
import { zhCNSftpMessages } from "@/features/i18n/messages/zh-CN/sftp";
import { zhCNTerminalMessages } from "@/features/i18n/messages/zh-CN/terminal";
import { zhCNServerMetricsMessages } from "@/features/i18n/messages/zh-CN/server-metrics";
import { zhCNTaskContainerMessages } from "@/features/i18n/messages/zh-CN/task-container";
import { zhCNStatisticsMessages } from "@/features/i18n/messages/zh-CN/statistics";
import { zhCNDeployTaskMessages } from "@/features/i18n/messages/zh-CN/deploy-task";
import { zhCNFileReaderMessages } from "@/features/i18n/messages/zh-CN/file-reader";
import { zhCNSessionActivityMessages } from "@/features/i18n/messages/zh-CN/session-activity";
import { zhCNDiagnoseMessages } from "@/features/i18n/messages/zh-CN/diagnose";
import { zhCNMediaPreviewMessages } from "@/features/i18n/messages/zh-CN/media-preview";

export const zhCNMessages = {
	...zhCNCommonMessages,
	...zhCNSettingsMessages,
	...zhCNWorkspaceMessages,
	...zhCNSessionMessages,
	...zhCNChatMessages,
	...zhCNGuardMessages,
	...zhCNProviderMessages,
	...zhCNSftpMessages,
	...zhCNTerminalMessages,
	...zhCNServerMetricsMessages,
	...zhCNTaskContainerMessages,
	...zhCNStatisticsMessages,
	...zhCNDeployTaskMessages,
	...zhCNFileReaderMessages,
	...zhCNSessionActivityMessages,
	...zhCNDiagnoseMessages,
	...zhCNMediaPreviewMessages,
} as const;

export type MessageId = keyof typeof zhCNMessages;
