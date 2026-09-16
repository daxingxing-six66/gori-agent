import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) throw new Error('Requires Node.js 22.19.0 or newer.');
if (process.argv.includes('--help')) {
  console.log('node scripts/start.mjs [--setup]\n--setup installs locked dependencies and builds the application.\nData: SSH_AGENT_DATA_DIR (default ~/.gori-agent).\nWeb port: SSH_AGENT_WEB_PORT (default 3000).\nAPI port: SSH_AGENT_PORT at build time (default 3001); rebuild to change it.');
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
const { apiPort } = JSON.parse(readFileSync(join(root, '.build-config.json'), 'utf8'));
const webPort = Number(process.env.SSH_AGENT_WEB_PORT ?? 3000);
for (const port of [apiPort, webPort]) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Ports must be between 1 and 65535.');
}
if (apiPort === webPort) throw new Error('The frontend and backend ports must differ.');
if (process.env.SSH_AGENT_PORT !== undefined && Number(process.env.SSH_AGENT_PORT) !== apiPort) {
  throw new Error('SSH_AGENT_PORT differs from the frontend build. Rebuild with the same SSH_AGENT_PORT before starting.');
}
for (const port of [webPort, apiPort]) {
  await new Promise((resolveReady, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Cannot bind 127.0.0.1:${port}. Check for another running instance.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolveReady));
  });
}
const data = resolve(process.env.SSH_AGENT_DATA_DIR || join(homedir(), '.gori-agent'));
mkdirSync(data, { recursive: true, mode: 0o700 });
const keyPath = join(data, 'credential-key');
if (!existsSync(keyPath) && existsSync(join(data, 'ssh-agent.sqlite'))) {
  throw new Error('Database exists but its key is missing. Restore credential-key from backup before starting.');
}
try {
  writeFileSync(keyPath, randomBytes(32).toString('base64'), { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
const key = readFileSync(keyPath, 'utf8').trim();
if (Buffer.from(key, 'base64').length !== 32 || Buffer.from(key, 'base64').toString('base64') !== key) {
  throw new Error('Saved key is invalid. Restore your backup; do not generate a replacement.');
}
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
    SSH_AGENT_DATABASE_PATH: join(data, 'ssh-agent.sqlite'),
    SSH_AGENT_CREDENTIAL_KEY_BASE64: key,
    SSH_AGENT_LOCAL_CWD: join(data, 'workspace'),
    SSH_AGENT_HOST: '127.0.0.1', SSH_AGENT_PORT: String(apiPort),
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
      const response = await fetch(`http://127.0.0.1:${apiPort}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { ready = true; break; }
    } catch { /* Backend may still be starting. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready || stopping) throw new Error(`Backend did not start. Check packages/ssh-agent/logs and port ${apiPort}.`);
  const webCli = join(root, 'node_modules/vinext/dist/cli.js');
  if (!existsSync(webCli)) throw new Error('Vinext CLI not found; run setup again.');
  const web = spawn(process.execPath, [webCli, 'start', '--hostname', '127.0.0.1', '--port', String(webPort)], {
    cwd: join(root, 'packages/ssh-agent-web'), stdio: 'inherit',
    env: { ...process.env, NEXT_PUBLIC_SSH_AGENT_API_BASE_URL: `http://127.0.0.1:${apiPort}` },
  });
  children.push(web);
  web.on('error', error => { console.error(error.message); stop(1); });
  web.on('exit', code => { if (!stopping) stop(code || 1); });
  console.log(`Data: ${data}\nOpen http://127.0.0.1:${webPort} when the web server is ready. Press Ctrl+C to stop.`);
} catch (error) {
  console.error(error.message);
  stop(1);
}
