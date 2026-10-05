import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureDocker } from './ensure-docker.mjs';
import { boundedLog } from './bounded-log.mjs';

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cube-docker-test-'));
  async function script(name, text) {
    const file = path.join(dir, name);
    await writeFile(file, `#!${process.execPath}\n${text}`, { mode: 0o700 });
    return file;
  }
  const docker = await script('docker.mjs', `import{existsSync}from'node:fs';process.exit(existsSync(process.env.DOCKER_FIXTURE+'/ready')?0:1);`);
  const rootless = await script('rootless.mjs', `import{writeFileSync,appendFileSync}from'node:fs';const dir=process.env.DOCKER_FIXTURE;appendFileSync(dir+'/starts','1\\n');writeFileSync(dir+'/pid',String(process.pid));setTimeout(()=>writeFileSync(dir+'/ready','1'),250);setInterval(()=>{},1000);`);
  // Portable fixture implementing flock's held-while-child-runs behavior.
  const flock = await script('flock.mjs', `import{mkdir,rm}from'node:fs/promises';import{spawn}from'node:child_process';import{setTimeout as delay}from'node:timers/promises';const args=process.argv.slice(2),lock=args[3]+'.fixture';while(true){try{await mkdir(lock);break}catch{await delay(20)}}try{const child=spawn(args[4],args.slice(5),{stdio:'inherit'});process.exitCode=await new Promise(r=>child.on('exit',r));}finally{await rm(lock,{recursive:true})}`);
  const env = { ...process.env, CUBE_DOCKER_HOME: dir, CUBE_DOCKER_BIN: docker, CUBE_DOCKER_ROOTLESS_BIN: rootless, CUBE_DOCKER_FLOCK_BIN: flock, DOCKER_FIXTURE: dir, CUBE_DOCKER_READY_TIMEOUT_MS: '2000' };
  return { dir, env, async close() {
    const pid = await readFile(path.join(dir, 'pid'), 'utf8').catch(() => '');
    if (pid) { try { process.kill(Number(pid), 'SIGTERM'); } catch {} await delay(100); }
    await rm(dir, { recursive: true, force: true });
  } };
}

test('healthy Docker is reused without touching or starting a daemon', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.dir, 'ready'), '1');
    const c = await ensureDocker({ env: f.env });
    assert.equal(c.socket, `unix://${f.dir}/.docker/run/docker.sock`);
    await assert.rejects(stat(path.join(f.dir, 'starts')));
  } finally { await f.close(); }
});

test('concurrent cold starts launch one detached daemon and await readiness', async () => {
  const f = await fixture();
  try {
    await Promise.all([ensureDocker({ env: f.env }), ensureDocker({ env: f.env })]);
    assert.equal(await readFile(path.join(f.dir, 'starts'), 'utf8'), '1\n');
    assert.equal((await stat(path.join(f.dir, '.docker/run'))).mode & 0o777, 0o700);
  } finally { await f.close(); }
});

test('startup timeout reports failure without stopping its daemon', async () => {
  const f = await fixture();
  try {
    const never = path.join(f.dir, 'never.mjs');
    await writeFile(never, `#!${process.execPath}\nimport{writeFileSync}from'node:fs';writeFileSync(process.env.DOCKER_FIXTURE+'/pid',String(process.pid));setInterval(()=>{},1000);`, { mode: 0o700 });
    await assert.rejects(ensureDocker({ env: { ...f.env, CUBE_DOCKER_ROOTLESS_BIN: never, CUBE_DOCKER_READY_TIMEOUT_MS: '100' } }), /did not become ready/);
    const pid = Number(await readFile(path.join(f.dir, 'pid'), 'utf8'));
    assert.doesNotThrow(() => process.kill(pid, 0));
  } finally { await f.close(); }
});

test('daemon logging retains at most two bounded files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cube-docker-log-'));
  try {
    const file = path.join(dir, 'daemon.log');
    const append = boundedLog(file, 32); append(Buffer.alloc(115, 65));
    assert.equal((await stat(file)).size, 19);
    assert.equal((await stat(`${file}.1`)).size, 32);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
