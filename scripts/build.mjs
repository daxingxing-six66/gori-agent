import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const apiPort = Number(process.env.SSH_AGENT_PORT ?? 3001);
if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) throw new Error('SSH_AGENT_PORT must be between 1 and 65535.');
rmSync(join(root, '.build-config.json'), { force: true });
for (const [workspace, script] of [
  ['@earendil-works/pi-telemetry', 'build'],
  ['@earendil-works/pi-ai', 'build:offline'],
  ['@earendil-works/pi-agent-core', 'build'],
  ['@pi/ssh-agent', 'build'],
  ['@pi/ssh-agent-web', 'build'],
]) {
  const result = spawnSync('npm', ['run', script, `--workspace=${workspace}`], {
    cwd: root, stdio: 'inherit', shell: process.platform === 'win32',
    env: { ...process.env, NEXT_PUBLIC_SSH_AGENT_API_BASE_URL: `http://127.0.0.1:${apiPort}` },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
writeFileSync(join(root, '.build-config.json'), JSON.stringify({ apiPort }) + '\n');
