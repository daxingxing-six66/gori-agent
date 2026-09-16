import type { GuardRulePackDefinition } from "../../domain/guard-rule-pack.ts";

export interface GuardRulePackCatalog {
	list(): readonly GuardRulePackDefinition[];
	find(id: string): GuardRulePackDefinition | undefined;
}

export class BuiltinGuardRulePackCatalog implements GuardRulePackCatalog {
	private readonly packs: readonly GuardRulePackDefinition[];
	private readonly packsById: ReadonlyMap<string, GuardRulePackDefinition>;

	constructor(packs: readonly GuardRulePackDefinition[] = BUILTIN_GUARD_RULE_PACKS) {
		validateCatalog(packs);
		this.packs = packs;
		this.packsById = new Map(packs.map((pack) => [pack.id, pack]));
	}

	list(): readonly GuardRulePackDefinition[] {
		return this.packs;
	}

	find(id: string): GuardRulePackDefinition | undefined {
		return this.packsById.get(id);
	}
}

const BUILTIN_GUARD_RULE_PACKS: readonly GuardRulePackDefinition[] = [
	{
		id: "linux-critical",
		name: "Linux 基础保护",
		description: "防止主机关机、系统权限损坏等基础高危操作",
		version: "1.0.0",
		recommended: true,
		rules: [
			blockingRegex(
				"linux.power.shutdown",
				"禁止关闭系统",
				String.raw`(^|\s)(sudo\s+)?shutdown(\s|$)`,
				"关闭系统会中断当前及其他远程会话",
			),
			blockingRegex(
				"linux.power.poweroff",
				"禁止关闭电源",
				String.raw`(^|\s)(sudo\s+)?poweroff(\s|$)`,
				"关闭电源会使主机停止服务",
			),
			blockingRegex(
				"linux.power.reboot",
				"禁止重启系统",
				String.raw`(^|\s)(sudo\s+)?reboot(\s|$)`,
				"重启会中断当前及其他远程会话",
			),
			blockingRegex(
				"linux.power.halt",
				"禁止停止系统",
				String.raw`(^|\s)(sudo\s+)?halt(\s|$)`,
				"停止系统会使主机停止服务",
			),
			blockingRegex(
				"linux.permissions.root-chmod",
				"禁止递归修改根目录权限",
				String.raw`(^|\s)(sudo\s+)?chmod\s+(-R\s+)?[^\s]+\s+/(\s|$)`,
				"修改根目录权限可能破坏整个系统",
			),
			blockingRegex(
				"linux.permissions.root-chown",
				"禁止递归修改根目录所有者",
				String.raw`(^|\s)(sudo\s+)?chown\s+(-R\s+)?[^\s]+\s+/(\s|$)`,
				"修改根目录所有者可能破坏整个系统",
			),
			blockingRegex(
				"linux.process.fork-bomb",
				"禁止 Fork Bomb",
				String.raw`:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:`,
				"Fork Bomb 会快速耗尽主机进程资源",
			),
		],
	},
	{
		id: "ssh-protection",
		name: "SSH 防失联",
		description: "防止停止 SSH 服务或删除关键连接配置",
		version: "1.0.0",
		recommended: true,
		rules: [
			blockingRegex(
				"ssh.systemctl-stop",
				"禁止停止 SSH 服务",
				String.raw`(^|\s)(sudo\s+)?systemctl\s+stop\s+(ssh|sshd)(\.service)?(\s|$)`,
				"停止 SSH 服务会导致远程连接失效",
			),
			blockingRegex(
				"ssh.systemctl-disable",
				"禁止禁用 SSH 服务",
				String.raw`(^|\s)(sudo\s+)?systemctl\s+(disable|mask)\s+(ssh|sshd)(\.service)?(\s|$)`,
				"禁用 SSH 服务可能导致主机重启后无法连接",
			),
			blockingRegex(
				"ssh.service-stop",
				"禁止通过 service 停止 SSH",
				String.raw`(^|\s)(sudo\s+)?service\s+(ssh|sshd)\s+stop(\s|$)`,
				"停止 SSH 服务会导致远程连接失效",
			),
			blockingRegex(
				"ssh.config-delete",
				"禁止删除 SSH 配置",
				String.raw`(^|\s)(sudo\s+)?rm\s+[^\n]*(/etc/ssh($|/)|/etc/ssh_config(\s|$)|/etc/sshd_config(\s|$))`,
				"删除 SSH 配置可能导致当前或后续连接失败",
			),
		],
	},
	{
		id: "disk-protection",
		name: "磁盘数据保护",
		description: "防止格式化、擦除或直接覆盖块设备",
		version: "1.0.0",
		recommended: true,
		rules: [
			blockingRegex(
				"disk.mkfs",
				"禁止格式化块设备",
				String.raw`(^|\s)(sudo\s+)?mkfs(\.[^\s]+)?\s+[^\n]*/dev/`,
				"格式化块设备会破坏其中的数据",
			),
			blockingRegex(
				"disk.wipefs",
				"禁止擦除文件系统签名",
				String.raw`(^|\s)(sudo\s+)?wipefs\s+[^\n]*/dev/`,
				"擦除文件系统签名会使磁盘数据不可访问",
			),
			blockingRegex(
				"disk.blkdiscard",
				"禁止丢弃块设备数据",
				String.raw`(^|\s)(sudo\s+)?blkdiscard\s+[^\n]*/dev/`,
				"丢弃块设备数据通常不可恢复",
			),
			blockingRegex(
				"disk.dd-device-output",
				"禁止使用 dd 覆盖块设备",
				String.raw`(^|\s)(sudo\s+)?dd\s+[^\n]*of=/dev/`,
				"直接覆盖块设备可能导致数据永久丢失",
			),
		],
	},
	{
		id: "network-protection",
		name: "网络连接保护",
		description: "防止网络配置变更导致当前 SSH 连接中断",
		version: "1.0.0",
		recommended: false,
		rules: [
			blockingRegex(
				"network.ip-link-down",
				"禁止关闭网卡",
				String.raw`(^|\s)(sudo\s+)?ip\s+link\s+set\s+[^\s]+\s+down(\s|$)`,
				"关闭网卡会中断当前 SSH 连接",
			),
			blockingRegex(
				"network.ip-flush",
				"禁止清除网卡 IP",
				String.raw`(^|\s)(sudo\s+)?ip\s+addr(ess)?\s+flush(\s|$)`,
				"清除网卡 IP 会中断当前 SSH 连接",
			),
			blockingRegex(
				"network.nmcli-off",
				"禁止关闭 NetworkManager 网络",
				String.raw`(^|\s)(sudo\s+)?nmcli\s+networking\s+off(\s|$)`,
				"关闭网络会中断当前 SSH 连接",
			),
		],
	},
];

function blockingRegex(originRuleId: string, displayName: string, pattern: string, reason: string) {
	return {
		originRuleId,
		displayName,
		pattern,
		match: "regex" as const,
		reason,
		enabled: true,
		level: "critical" as const,
	};
}

function validateCatalog(packs: readonly GuardRulePackDefinition[]): void {
	const packIds = new Set<string>();
	const originRuleIds = new Set<string>();
	for (const pack of packs) {
		requireCatalogText(pack.id, "pack.id");
		requireCatalogText(pack.name, `${pack.id}.name`);
		requireCatalogText(pack.description, `${pack.id}.description`);
		requireCatalogText(pack.version, `${pack.id}.version`);
		if (typeof pack.recommended !== "boolean") throw new Error(`Invalid recommended flag: ${pack.id}`);
		if (packIds.has(pack.id)) throw new Error(`Duplicate Guard rule pack id: ${pack.id}`);
		packIds.add(pack.id);
		if (pack.rules.length === 0) throw new Error(`Guard rule pack has no rules: ${pack.id}`);
		for (const rule of pack.rules) {
			requireCatalogText(rule.originRuleId, `${pack.id}.rules.originRuleId`);
			requireCatalogText(rule.displayName, `${rule.originRuleId}.displayName`);
			requireCatalogText(rule.pattern, `${rule.originRuleId}.pattern`);
			if (rule.reason !== undefined) requireCatalogText(rule.reason, `${rule.originRuleId}.reason`);
			if (typeof rule.enabled !== "boolean") throw new Error(`Invalid enabled flag: ${rule.originRuleId}`);
			if (rule.level !== "critical" && rule.level !== "strict") {
				throw new Error(`Invalid Guard rule level in catalog: ${rule.originRuleId}`);
			}
			if (originRuleIds.has(rule.originRuleId))
				throw new Error(`Duplicate Guard origin rule id: ${rule.originRuleId}`);
			originRuleIds.add(rule.originRuleId);
			if (rule.match === "regex") new RegExp(rule.pattern);
			else if (rule.match !== "contains" && rule.match !== "starts_with") {
				throw new Error(`Invalid Guard match mode in catalog: ${rule.originRuleId}`);
			}
		}
	}
}

function requireCatalogText(value: string, field: string): void {
	if (value.trim().length === 0) throw new Error(`Guard rule pack catalog field is empty: ${field}`);
}
