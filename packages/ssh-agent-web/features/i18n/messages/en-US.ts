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
} satisfies Record<MessageId, string>;
