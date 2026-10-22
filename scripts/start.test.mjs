import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const signalTestSkip = process.platform === 'win32' ? 'Requires POSIX signal delivery and process groups.' : false;

async function freePorts() {
  const servers = [createServer(), createServer(), createServer()];
  try {
    await Promise.all(servers.map(server => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    })));
    return servers.map(server => server.address().port);
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
}

async function until(read, accept = Boolean) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error('Timed out waiting for development servers', { cause: lastError });
}

async function health(port) {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
  assert.equal(response.status, 200);
  return response.json();
}

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'gori-dev-')));
  const runs = [];
  t.after(async () => {
    for (const { child, closed } of runs) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await closed;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const write = async (path, content) => {
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  for (const path of ['scripts/start.mjs', 'scripts/transport-config.mjs', 'tsconfig.json', 'tsconfig.base.json']) {
    await mkdir(join(directory, 'scripts'), { recursive: true });
    await cp(join(root, path), join(directory, path));
  }
  await write('package.json', '{"type":"module"}');
  // No dist directories: these imports must resolve through the real source aliases.
  await write('packages/telemetry/src/index.ts', 'export const telemetry = "telemetry-1";');
  await write('packages/ai/src/index.ts', 'export const ai = "ai-1";');
  await write('packages/agent/src/index.ts', `
import { ai } from '@earendil-works/pi-ai';
import { telemetry } from '@earendil-works/pi-telemetry';
export const values = ["agent-1", ai, telemetry];
`);
  const backendSource = `
import { createServer } from 'node:http';
import { values } from '@earendil-works/pi-agent-core';
const servers = [process.env.SSH_AGENT_PORT, process.env.SSH_AGENT_EVENTS_PORT].map(port =>
  createServer((request, response) => response.end(JSON.stringify({
    pid: process.pid, values, version: 'backend-1', cwd: process.cwd(),
    cors: process.env.SSH_AGENT_CORS_ORIGINS, data: process.env.SSH_AGENT_DATA_DIR,
  }))).listen(Number(port), process.env.SSH_AGENT_HOST));
process.on('SIGTERM', () => servers.forEach(server => server.close()));
`;
  await write('packages/ssh-agent/src/server/main.ts', backendSource);
  await mkdir(join(directory, 'packages/ssh-agent-web'), { recursive: true });
  await mkdir(join(directory, 'node_modules'), { recursive: true });
  await symlink(join(root, 'node_modules/tsx'), join(directory, 'node_modules/tsx'), process.platform === 'win32' ? 'junction' : 'dir');
  // Use the real tsx watcher, but a small web fixture to keep this test independent of UI builds.
  await write('node_modules/vinext/dist/cli.js', `
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
createServer((request, response) => response.end(JSON.stringify({
  pid: process.pid, workerPid: worker.pid, mode: process.argv[2],
  api: process.env.NEXT_PUBLIC_SSH_AGENT_API_BASE_URL,
  events: process.env.NEXT_PUBLIC_SSH_AGENT_EVENTS_BASE_URL,
}))).listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1');
`);
  const [webPort, apiPort, eventsPort] = await freePorts();
  const data = join(directory, 'data');
  const launch = (development = true) => {
    const child = spawn(process.execPath, ['scripts/start.mjs', ...(development ? ['--dev'] : [])], {
      cwd: directory,
      env: {
        ...process.env, SSH_AGENT_WEB_PORT: String(webPort), SSH_AGENT_PORT: String(apiPort),
        SSH_AGENT_EVENTS_PORT: String(eventsPort), SSH_AGENT_DATA_DIR: data,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const closed = once(child, 'close');
    runs.push({ child, closed });
    return { child, closed, output: () => output };
  };
  return { directory, write, backendSource, launch, data, webPort, apiPort, eventsPort };
}

test('dev loads and watches every backend workspace without builds, recovers from errors, and stops its workers', { timeout: 60_000, skip: signalTestSkip }, async t => {
  const f = await fixture(t);
  // A production build record must neither be used nor overwritten in development.
  await f.write('.build-config.json', '{"apiPort":1,"eventsPort":2}\n');
  const run = f.launch();
  const web = await until(() => health(f.webPort));
  let backend = await health(f.apiPort);
  assert.equal(web.mode, 'dev');
  assert.equal(web.api, `http://127.0.0.1:${f.apiPort}`);
  assert.equal(web.events, `http://127.0.0.1:${f.eventsPort}`);
  assert.deepEqual(backend.values, ['agent-1', 'ai-1', 'telemetry-1']);
  assert.equal(backend.cwd, f.data);
  assert.equal(backend.cors, `http://127.0.0.1:${f.webPort},http://localhost:${f.webPort}`);
  assert.equal((await health(f.eventsPort)).pid, backend.pid);

  for (const [name, index] of [['telemetry', 2], ['ai', 1], ['agent', 0]]) {
    const path = `packages/${name}/src/index.ts`;
    const source = await readFile(join(f.directory, path), 'utf8');
    await f.write(path, source.replace(`${name}-1`, `${name}-2`));
    const previousPid = backend.pid;
    backend = await until(() => health(f.apiPort), value => value.values[index] === `${name}-2`);
    assert.notEqual(backend.pid, previousPid);
    assert.equal((await health(f.webPort)).pid, web.pid);
  }
  // Also watch files that have not been imported yet.
  await f.write('packages/telemetry/src/new-module.ts', 'export const added = true;');
  const previousPid = backend.pid;
  backend = await until(() => health(f.apiPort), value => value.pid !== previousPid);
  await f.write('packages/ssh-agent/src/server/main.ts', 'const broken = ;');
  await until(() => run.output().includes('TransformError'));
  assert.equal((await health(f.webPort)).pid, web.pid);
  await f.write('packages/ssh-agent/src/server/main.ts', f.backendSource.replace('backend-1', 'backend-2'));
  backend = await until(() => health(f.apiPort), value => value.version === 'backend-2');
  assert.equal(await readFile(join(f.directory, '.build-config.json'), 'utf8'), '{"apiPort":1,"eventsPort":2}\n');

  run.child.kill('SIGINT');
  const [code] = await run.closed;
  assert.equal(code, 0, run.output());
  for (const port of [f.webPort, f.apiPort, f.eventsPort]) {
    await assert.rejects(() => health(port));
  }
  for (const pid of [web.pid, web.workerPid, backend.pid]) {
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  }
});

test('a failed web process stops the backend watcher and releases its ports', { timeout: 30_000, skip: signalTestSkip }, async t => {
  const f = await fixture(t);
  const run = f.launch();
  const web = await until(() => health(f.webPort));
  const backend = await health(f.apiPort);
  process.kill(web.pid, 'SIGTERM');
  const [code] = await run.closed;
  assert.notEqual(code, 0);
  await assert.rejects(() => health(f.apiPort));
  await assert.rejects(() => health(f.eventsPort));
  assert.throws(() => process.kill(backend.pid, 0));
  await until(() => { try { process.kill(web.workerPid, 0); return false; } catch { return true; } });
});

test('production still uses built backend, recorded ports, and web start with the same process cleanup', { timeout: 30_000, skip: signalTestSkip }, async t => {
  const f = await fixture(t);
  await f.write('.build-config.json', JSON.stringify({ apiPort: f.apiPort, eventsPort: f.eventsPort }));
  await f.write('packages/ssh-agent/dist/server/main.js', f.backendSource.replace(
    "import { values } from '@earendil-works/pi-agent-core';", 'const values = ["built"];',
  ));
  const run = f.launch(false);
  const web = await until(() => health(f.webPort));
  assert.equal(web.mode, 'start');
  assert.deepEqual((await health(f.apiPort)).values, ['built']);
  run.child.kill('SIGTERM');
  const [code] = await run.closed;
  assert.equal(code, 0, run.output());
  for (const port of [f.webPort, f.apiPort, f.eventsPort]) await assert.rejects(() => health(port));
});

test('an occupied port fails before starting children and leaves the existing server running', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const server = createServer();
  server.listen(f.apiPort, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const run = f.launch();
  const [code] = await run.closed;
  assert.notEqual(code, 0);
  assert.match(run.output(), /Cannot bind/);
  assert.equal(server.listening, true);
  await assert.rejects(() => health(f.webPort));
});
