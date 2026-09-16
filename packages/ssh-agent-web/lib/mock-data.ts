export interface WorkspaceSummary {
	id: string;
	name: string;
	host: string;
	environment: "PROD" | "STAGE" | "DEV";
	connected: boolean;
}

export interface SessionSummary {
	id: string;
	workspaceId: string;
	title: string;
	updatedAt: string;
	active?: boolean;
}

export const workspaces: WorkspaceSummary[] = [
	{
		id: "production-api",
		name: "Production API",
		host: "ubuntu@10.24.8.16",
		environment: "PROD",
		connected: true,
	},
	{
		id: "staging-web",
		name: "Staging Web",
		host: "deploy@10.24.5.22",
		environment: "STAGE",
		connected: true,
	},
	{
		id: "data-worker",
		name: "Data Worker",
		host: "ops@10.24.12.7",
		environment: "PROD",
		connected: false,
	},
];

export const sessions: SessionSummary[] = [
	{ id: "deploy-failure", workspaceId: "production-api", title: "修复部署后 502", updatedAt: "刚刚", active: true },
	{ id: "disk-cleanup", workspaceId: "production-api", title: "清理磁盘空间", updatedAt: "昨天" },
	{ id: "nginx-tuning", workspaceId: "production-api", title: "调整 Nginx 配置", updatedAt: "8 月 18 日" },
	{ id: "release-check", workspaceId: "staging-web", title: "发布前健康检查", updatedAt: "2 小时前" },
	{ id: "memory-growth", workspaceId: "staging-web", title: "追踪内存增长", updatedAt: "8 月 20 日" },
	{ id: "worker-restart", workspaceId: "data-worker", title: "Worker 重启排查", updatedAt: "8 月 19 日" },
];

export const commandOutput = [
	"● api.service - Production API",
	"     Loaded: loaded (/etc/systemd/system/api.service; enabled)",
	"     Active: failed (Result: exit-code) since 10:42:18 CST",
	"    Process: 28419 ExecStart=/opt/api/current/bin/server",
	"   Main PID: 28419 (code=exited, status=1/FAILURE)",
];

export const guardRules = ["阻止修改 SSH 服务", "阻止磁盘格式化命令", "阻止系统关机命令"];
