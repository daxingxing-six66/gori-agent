import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { assertBuildTransportMatches, browserTransportEnvironment, validatePorts } from './transport-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) throw new Error('Requires Node.js 22.19.0 or newer.');
if (process.argv.includes('--help')) {
  console.log('node scripts/start.mjs [--setup]\n--setup installs locked dependencies and builds the application.\nData: SSH_AGENT_DATA_DIR (default ~/.gori-agent).\nWeb port: SSH_AGENT_WEB_PORT (default 3000).\nAPI / events ports: SSH_AGENT_PORT / SSH_AGENT_EVENTS_PORT at build time (defaults 3001 / 3002); rebuild to change them.');
  process.exit(0);
}
if (process.argv.includes('--setup')) {
  for (const args of [['ci', '--ignore-scripts'], ['run', 'build']]) {
    const result = spawnSync('npm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
if (!existsSync(join(root, 'packages/ssh-agent/dist/server/main.js')) || !existsSync(join(root, '.build-config.json'))) {
  throw new Error('Run first: node scripts/start.mjs --setup');
}
process.umask(0o077);
const transport = JSON.parse(readFileSync(join(root, '.build-config.json'), 'utf8'));
const { apiPort, eventsPort } = transport;
if (eventsPort === undefined) throw new Error('The build has no separate events endpoint. Run npm run build before starting.');
const webPort = Number(process.env.SSH_AGENT_WEB_PORT ?? 3000);
validatePorts({ webPort, apiPort, eventsPort });
assertBuildTransportMatches(transport);
for (const port of [webPort, apiPort, eventsPort]) {
  await new Promise((resolveReady, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Cannot bind 127.0.0.1:${port}. Check for another running instance.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolveReady));
  });
}
const dataValue = process.env.SSH_AGENT_DATA_DIR?.trim() || join(homedir(), '.gori-agent');
const data = resolve(dataValue === '~' ? homedir() : dataValue.startsWith('~/') ? join(homedir(), dataValue.slice(2)) : dataValue);
mkdirSync(data, { recursive: true, mode: 0o700 });
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  const timer = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, 5000);
  timer.unref();
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
const backend = spawn(process.execPath, [join(root, 'packages/ssh-agent/dist/server/main.js')], {
  cwd: data, stdio: 'inherit',
  env: {
    ...process.env,
    SSH_AGENT_DATA_DIR: data,
    SSH_AGENT_DATABASE_PATH: process.env.SSH_AGENT_DATABASE_PATH?.trim() === ':memory:' ? ':memory:' : resolve(process.env.SSH_AGENT_DATABASE_PATH?.trim() || join(data, 'ssh-agent.sqlite')),
    SSH_AGENT_LOCAL_CWD: process.env.SSH_AGENT_LOCAL_CWD || join(data, 'workspace'),
    SSH_AGENT_HOST: '127.0.0.1', SSH_AGENT_PORT: String(apiPort),
    SSH_AGENT_EVENTS_PORT: String(eventsPort),
    SSH_AGENT_CORS_ORIGINS: `http://127.0.0.1:${webPort},http://localhost:${webPort}`,
  },
});
children.push(backend);
backend.on('error', error => { console.error(error.message); stop(1); });
backend.on('exit', code => { if (!stopping) stop(code || 1); });
try {
  let ready = false;
  for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
    try {
      const responses = await Promise.all([apiPort, eventsPort].map(port =>
        fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) })));
      if (responses.every(response => response.ok)) { ready = true; break; }
    } catch { /* Backend may still be starting. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready || stopping) throw new Error(`Backend did not start. Check ${join(data, 'logs')} and ports ${apiPort} / ${eventsPort}.`);
  const webCli = join(root, 'node_modules/vinext/dist/cli.js');
  if (!existsSync(webCli)) throw new Error('Vinext CLI not found; run setup again.');
  const web = spawn(process.execPath, [webCli, 'start', '--hostname', '127.0.0.1', '--port', String(webPort)], {
    cwd: join(root, 'packages/ssh-agent-web'), stdio: 'inherit',
    env: { ...process.env, ...browserTransportEnvironment(transport) },
  });
  children.push(web);
  web.on('error', error => { console.error(error.message); stop(1); });
  web.on('exit', code => { if (!stopping) stop(code || 1); });
  console.log(`Data: ${data}\nOpen http://127.0.0.1:${webPort} when the web server is ready. Press Ctrl+C to stop.`);
} catch (error) {
  console.error(error.message);
  stop(1);
}
