import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { assertBuildTransportMatches, browserTransportEnvironment, buildTransportConfig, validatePorts } from './transport-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const development = process.argv.includes('--dev');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) throw new Error('Requires Node.js 22.19.0 or newer.');
if (process.argv.includes('--help')) {
  console.log('node scripts/start.mjs [--setup | --dev]\n--setup installs locked dependencies and builds the application.\n--dev runs the frontend with HMR and watches backend / agent / ai / telemetry sources; no build required.\nData: SSH_AGENT_DATA_DIR (default ~/.gori-agent).\nWeb port: SSH_AGENT_WEB_PORT (default 3000).\nAPI / events ports: SSH_AGENT_PORT / SSH_AGENT_EVENTS_PORT (defaults 3001 / 3002); production requires a matching build.');
  process.exit(0);
}
if (development && process.argv.includes('--setup')) throw new Error('Use --setup for production or --dev for development, not both.');
if (process.argv.includes('--setup')) {
  for (const args of [['ci', '--ignore-scripts'], ['run', 'build']]) {
    const result = spawnSync('npm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
if (!development && (!existsSync(join(root, 'packages/ssh-agent/dist/server/main.js')) || !existsSync(join(root, '.build-config.json')))) {
  throw new Error('Run first: node scripts/start.mjs --setup');
}
const webCli = join(root, 'node_modules/vinext/dist/cli.js');
const tsxCli = join(root, 'node_modules/tsx/dist/cli.mjs');
if (!existsSync(webCli) || (development && !existsSync(tsxCli))) {
  throw new Error('Dependencies not found. Run npm ci --ignore-scripts first.');
}
process.umask(0o077);
const transport = development ? buildTransportConfig() : JSON.parse(readFileSync(join(root, '.build-config.json'), 'utf8'));
const { apiPort, eventsPort } = transport;
if (eventsPort === undefined) throw new Error('The build has no separate events endpoint. Run npm run build before starting.');
const webPort = Number(process.env.SSH_AGENT_WEB_PORT ?? 3000);
validatePorts({ webPort, apiPort, eventsPort });
if (!development) assertBuildTransportMatches(transport);
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
function terminate(child, force = false) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // Windows cannot relay POSIX signals to the tsx worker, so stop the whole tree.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      .on('error', error => console.error(error.message));
  } else if (force) {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
  } else {
    child.kill('SIGTERM');
  }
}
function track(child) {
  children.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => {
    // Clean up workers even if their parent exited before the shutdown timeout.
    if (process.platform !== 'win32') terminate(child, true);
    if (!stopping) stop(code || 1);
  });
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) terminate(child);
  const timer = setTimeout(() => {
    for (const child of children) terminate(child, true);
  }, 7000);
  timer.unref();
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
const backendArguments = development ? [
  tsxCli, 'watch', '--clear-screen=false', '--tsconfig', join(root, 'tsconfig.json'),
  ...['ssh-agent', 'agent', 'ai', 'telemetry'].flatMap(name => ['--include', join(root, 'packages', name, 'src')]),
  '--include', join(root, 'tsconfig.json'), '--include', join(root, 'tsconfig.base.json'),
  join(root, 'packages/ssh-agent/src/server/main.ts'),
] : [join(root, 'packages/ssh-agent/dist/server/main.js')];
const backend = spawn(process.execPath, backendArguments, {
  cwd: data, stdio: 'inherit', detached: process.platform !== 'win32',
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
track(backend);
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
  const web = spawn(process.execPath, [webCli, development ? 'dev' : 'start', '--hostname', '127.0.0.1', '--port', String(webPort)], {
    cwd: join(root, 'packages/ssh-agent-web'), stdio: 'inherit', detached: process.platform !== 'win32',
    env: { ...process.env, ...browserTransportEnvironment(transport) },
  });
  track(web);
  console.log(`Data: ${data}\nOpen http://127.0.0.1:${webPort} when the web server is ready. Press Ctrl+C to stop.`);
  if (development) console.log('Development: frontend HMR; backend, agent, ai and telemetry source changes restart the backend.');
} catch (error) {
  console.error(error.message);
  stop(1);
}
