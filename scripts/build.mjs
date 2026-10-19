import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildTransportConfig, browserTransportEnvironment } from './transport-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const transport = buildTransportConfig();
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
    env: { ...process.env, ...browserTransportEnvironment(transport) },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
writeFileSync(join(root, '.build-config.json'), JSON.stringify(transport) + '\n');
