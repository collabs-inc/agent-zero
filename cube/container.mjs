import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { dockerConfig, dockerReady } from './ensure-docker.mjs';
import { freePort } from './gateway.mjs';
import { boundedLog } from './bounded-log.mjs';

export const IMAGE = 'agent0ai/agent-zero@sha256:1ab9d73c448ba44d1a569803be8ae586b092fa3dedb7422061b61e9cdf877e88';
const exec = promisify(execFile);
export function appData(env = process.env) {
  return env.CUBE_AGENT_ZERO_DATA_DIR || path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'cube-agent-zero');
}
export async function dockerCommand(config, args, options = {}) {
  return exec(config.docker, ['--host', config.socket, ...args], { env: config.env, timeout: 30000, maxBuffer: 1024 * 1024, ...options });
}
async function containerOwner(config, name) {
  try { return (await dockerCommand(config, ['container', 'inspect', '--format', '{{ index .Config.Labels "computer.cube.owner" }}', name])).stdout.trim(); }
  catch (error) { if (/No such (object|container)/i.test(error.stderr || '')) return null; throw error; }
}
async function stopOwned(config, owner) {
  const token = await containerOwner(config, owner.name);
  if (token === null) return;
  if (token !== owner.token) throw new Error('Refusing to stop a container not owned by this app.');
  // Cube escalates HUP -> TERM -> KILL in about 2.25 seconds. Let Docker's
  // server-side stop transaction complete inside that window.
  await dockerCommand(config, ['stop', '--time', '1', owner.name], { timeout: 1800 });
  // --rm normally removes it; an interrupted prior run may already be stopped.
  if (await containerOwner(config, owner.name) !== null) await dockerCommand(config, ['rm', '--force', owner.name]);
}
function live(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }

export async function startContainer({ data = appData(), env = process.env, waitMs = 45000, onExit = () => {} } = {}) {
  const config = dockerConfig(env);
  if (!await dockerReady(config)) throw new Error('Rootless Docker is unavailable; restart the app to start it before acquiring the app lock.');
  await mkdir(path.join(data, 'usr'), { recursive: true, mode: 0o700 });
  const record = path.join(data, 'cube-container.json');
  const owner = { pid: process.pid, name: `cube-agent-zero-${randomUUID()}`, token: randomUUID() };
  try { await writeFile(record, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = JSON.parse(await readFile(record, 'utf8'));
    if (!Number.isInteger(previous.pid) || !previous.name?.startsWith('cube-agent-zero-') || !previous.token) throw new Error('Invalid Agent Zero ownership record; inspect it before restarting.');
    if (live(previous.pid)) throw new Error('Agent Zero is already supervised by another live process.');
    await stopOwned(config, previous);
    await unlink(record);
    await writeFile(record, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  }
  const innerPort = await freePort();
  const log = boundedLog(path.join(data, 'cube-container.log'), 2 * 1024 * 1024);
  const args = ['create', '--rm', '--pull=never', '--platform=linux/amd64', '--name', owner.name,
    '--label', 'computer.cube.app=agent-zero', '--label', `computer.cube.owner=${owner.token}`,
    '--publish', `127.0.0.1:${innerPort}:80`, '--mount', `type=bind,src=${path.join(data, 'usr')},dst=/a0/usr`,
    '--log-driver', 'local', '--log-opt', 'max-size=5m', '--log-opt', 'max-file=2',
    '--env', 'ALLOWED_ORIGINS=https://*.cube.site,http://127.0.0.1:*,http://localhost:*', IMAGE];
  const append = bytes => { try { log(bytes); } catch {} };
  let stopping = false, exited = false, failed, child, created = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    await stopOwned(config, owner);
    if (!exited) child?.kill('SIGTERM');
    // Late Docker creation can only leave an inert container. Keep its owner
    // record so the next supervisor can reclaim it after this process exits.
    if (!created) return;
    const current = JSON.parse(await readFile(record, 'utf8'));
    if (current.token === owner.token) await unlink(record);
  }
  const ready = (async () => {
    await dockerCommand(config, args, { timeout: 45000 });
    created = true;
    if (stopping) throw new Error('Agent Zero stopped during startup.');
    child = spawn(config.docker, ['--host', config.socket, 'start', '--attach', owner.name], { env: config.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.on('error', error => { failed = error; exited = true; if (!stopping) onExit(error); });
    child.on('exit', code => { exited = true; if (!stopping) onExit(new Error(`Agent Zero container exited (${code}).`)); });
    const deadline = Date.now() + waitMs;
    while (!exited && Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${innerPort}/api/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) return;
      } catch {}
      await delay(250);
    }
    throw failed || new Error(`Agent Zero did not become ready; inspect ${path.join(data, 'cube-container.log')}.`);
  })();
  return { innerPort, ready, stop };
}
