import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai";
import { createSqliteManagementBackend } from "../../packages/ssh-agent/src/runtime/create-sqlite-management-backend.ts";

// Explicit fixture only: loopback, dedicated disposable user, synthetic password.
// The caller must provision /opt/app owned by goritest, plus Bash/coreutils/Node.
const port = Number(process.env.GORI_SANDBOX_TEST_PORT);
assert(Number.isInteger(port) && port > 0 && port <= 65535, "Set GORI_SANDBOX_TEST_PORT to the disposable SSH fixture's loopback port");
const backend = createSqliteManagementBackend({ databasePath: ":memory:", localCwd: "/tmp",
	credentialEncryptionKey: new Uint8Array(32).fill(7), llmModelsFactory: (credentials) => createModels({ credentials }) });
async function request(path, body) {
	const response = await backend.handleRequest(new Request(`http://localhost/api${path}`, { method: "POST",
		...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
	const value = await response.json();
	assert(response.ok, JSON.stringify(value));
	return value;
}
try {
	const { workspace } = await request("/workspaces", { displayName: "Disposable sandbox fixture", environment: "development",
		host: { hostname: "127.0.0.1", port }, credential: { displayName: "synthetic", remoteUser: "goritest", type: "password", password: "gori-synthetic-test-password" },
		defaultCwd: "/tmp", sandboxWritableRoots: ["/opt/app"] });
	const session = await request(`/workspaces/${workspace.id}/sessions`, { displayName: "fixture" });
	const facts = await request(`/workspaces/${workspace.id}/sandbox`);
	assert.equal(facts.enforcement, "full");
	assert(facts.abi >= 5);
	let id = 0;
	const command = (script, extra = {}) => backend.commandOperations.submit({ sessionId: session.id, toolCallId: `smoke-${++id}`, command: script, cwd: "/opt/app", ...extra });
	const allowed = await command("cat /etc/hosts >/dev/null; echo allowed > allowed; /bin/sh -c 'echo child > child'");
	assert.equal(allowed.operation.status, "completed", JSON.stringify(allowed));
	assert.equal(allowed.operation.sandbox.enforcement, "full");
	const denied = await command("echo partial > partial; node -e \"require('fs').writeFileSync('/home/goritest/outside','denied')\"");
	assert.equal(denied.operation.failure?.code, "sandbox_denied", JSON.stringify(denied));
	assert.equal(denied.operation.sandbox.commandMayHaveRun, true);
	const effects = await command("cat partial; test ! -e /home/goritest/outside");
	assert.equal(effects.operation.status, "completed", JSON.stringify(effects));
	assert.equal(effects.outputTail.trim(), "partial");
	const bypass = await command("touch /home/goritest/full", { sandboxPermissions: "full_access", justification: "synthetic test", agentRunId: "smoke" });
	assert.equal(bypass.operation.failure?.code, "sandbox_approval_required");
	const badCwd = await command("echo must-not-run; touch /opt/app/cwd-bypass", { cwd: "/gori-missing-fixture-directory" });
	assert.equal(badCwd.operation.status, "failed");
	assert.equal((await command("test ! -e /opt/app/cwd-bypass && test ! -e /home/goritest/full")).operation.status, "completed");
	console.log(`Real SSH sandbox smoke test passed: ABI ${facts.abi}, SFTP deployment, exec confinement, descendant denial, partial effects and approval/cwd gates.`);
} finally { await backend.close(); }
