import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, access } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
export function dockerConfig(env = process.env) {
  const home = env.CUBE_DOCKER_HOME || os.homedir();
  const runtime = path.join(home, '.docker/run');
  const socket = `unix://${path.join(runtime, 'docker.sock')}`;
  return {
    home, runtime, socket,
    docker: env.CUBE_DOCKER_BIN || path.join(home, '.local/bin/docker'),
    rootless: env.CUBE_DOCKER_ROOTLESS_BIN || path.join(home, '.local/bin/dockerd-rootless.sh'),
    flock: env.CUBE_DOCKER_FLOCK_BIN || 'flock',
    timeout: Number(env.CUBE_DOCKER_READY_TIMEOUT_MS || 30000),
    env: { ...env, XDG_RUNTIME_DIR: runtime, DOCKER_HOST: socket, PATH: `${path.join(home, '.local/bin')}:${env.PATH || ''}` },
  };
}
export async function dockerReady(config) {
  try {
    await exec(config.docker, ['--host', config.socket, 'info', '--format', '{{.ServerVersion}}'], {
      env: config.env, timeout: 2000, maxBuffer: 8192,
    });
    return true;
  } catch { return false; }
}

// Shared across Cube Docker apps. Never restart or stop an existing daemon.
export async function ensureDocker({ env = process.env, locked = false } = {}) {
  const config = dockerConfig(env);
  if (await dockerReady(config)) return config;
  await mkdir(config.runtime, { recursive: true, mode: 0o700 });
  if (!locked) {
    // The second check in the locked process handles simultaneous app starts.
    await exec(config.flock, ['--close', '--wait', '35', path.join(config.runtime, 'cube-start.lock'),
      process.execPath, fileURLToPath(import.meta.url), '--locked'], {
      env: config.env, timeout: 70000, maxBuffer: 8192,
    });
    if (!await dockerReady(config)) throw new Error('Rootless Docker lost readiness after startup.');
    return config;
  }
  if (await dockerReady(config)) return config;
  await access(config.rootless);
  await mkdir(path.join(config.home, '.local/share/docker'), { recursive: true, mode: 0o700 });
  const daemon = spawn(process.execPath, [fileURLToPath(new URL('./docker-daemon.mjs', import.meta.url))], {
    env: config.env, detached: true, stdio: 'ignore',
  });
  await new Promise((resolve, reject) => { daemon.once('spawn', resolve); daemon.once('error', reject); });
  daemon.unref();
  const deadline = Date.now() + config.timeout;
  while (Date.now() < deadline) {
    if (await dockerReady(config)) return config;
    await delay(250);
  }
  throw new Error(`Rootless Docker did not become ready; inspect ${path.join(config.runtime, 'cube-dockerd.log')}. The daemon was not stopped.`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  ensureDocker({ locked: process.argv.includes('--locked') }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
