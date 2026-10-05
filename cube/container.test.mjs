import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { startContainer, IMAGE } from './container.mjs';

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cube-agent-zero-test-'));
  const docker = path.join(dir, 'docker.mjs');
  await writeFile(docker, `#!${process.execPath}
import http from 'node:http';import{readFileSync,writeFileSync,unlinkSync,existsSync}from'node:fs';import{setTimeout as delay}from'node:timers/promises';
const args=process.argv.slice(4),root=process.env.CONTAINER_FIXTURE,file=root+'/container.json';
const get=()=>existsSync(file)?JSON.parse(readFileSync(file)):null;
if(args[0]==='info'){console.log('29.8.2')}
else if(args[0]==='run'){
 const name=args[args.indexOf('--name')+1],token=args.find(s=>s.startsWith('computer.cube.owner=')).split('=')[1],port=Number(args[args.indexOf('--publish')+1].split(':')[1]);
 writeFileSync(root+'/args.json',JSON.stringify(args));writeFileSync(file,JSON.stringify({pid:process.pid,name,token}));
 const server=http.createServer((req,res)=>{res.writeHead(process.env.FIXTURE_NO_READY?'503':'200',{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true}))}).listen(port,'127.0.0.1');
 process.on('SIGTERM',()=>{unlinkSync(file);server.closeAllConnections();server.close(()=>process.exit(0))});
}else if(args[0]==='container'&&args[1]==='inspect'){
 const c=get();if(c&&c.name===args.at(-1)){console.log(c.token)}else{console.error('No such container');process.exitCode=1}
}else if(args[0]==='stop'){
 writeFileSync(root+'/stopped',args.at(-1));const c=get();if(c){process.kill(c.pid,'SIGTERM');for(let i=0;i<100&&get();i++)await delay(10)}
}else if(args[0]!=='rm'){console.error('Unexpected fake Docker command');process.exitCode=1}
`, { mode: 0o700 });
  return { dir, data: path.join(dir, 'data'), env: { ...process.env, CUBE_DOCKER_HOME: dir, CUBE_DOCKER_BIN: docker, CONTAINER_FIXTURE: dir }, async close() { await rm(dir, { recursive: true, force: true }); } };
}

test('container is pinned, loopback-only, persistent and stopped with its owner', async () => {
  const f = await fixture(); let app;
  try {
    app = await startContainer({ data: f.data, env: f.env }); await app.ready;
    const args = JSON.parse(await readFile(path.join(f.dir, 'args.json')));
    assert.equal(args.at(-1), IMAGE);
    assert.equal(args[args.indexOf('--publish') + 1], `127.0.0.1:${app.innerPort}:80`);
    assert.equal(args[args.indexOf('--mount') + 1], `type=bind,src=${f.data}/usr,dst=/a0/usr`);
    await writeFile(path.join(f.data, 'usr/persisted.txt'), 'survives');
    await app.stop(); app = null;
    await assert.rejects(access(path.join(f.data, 'cube-container.json')));
    app = await startContainer({ data: f.data, env: f.env }); await app.ready;
    assert.equal(await readFile(path.join(f.data, 'usr/persisted.txt'), 'utf8'), 'survives');
    await app.stop(); app = null;
    await assert.rejects(access(path.join(f.dir, 'container.json')));
  } finally { await app?.stop(); await f.close(); }
});

test('readiness failure can stop its own container cleanly', async () => {
  const f = await fixture(); let app;
  try {
    app = await startContainer({ data: f.data, env: { ...f.env, FIXTURE_NO_READY: '1' }, waitMs: 200 });
    await assert.rejects(app.ready, /did not become ready/);
    await app.stop(); app = null;
    await assert.rejects(access(path.join(f.dir, 'container.json')));
  } finally { await app?.stop(); await f.close(); }
});

test('another live supervisor and foreign container ownership are never stopped', async () => {
  const f = await fixture(); let app;
  try {
    app = await startContainer({ data: f.data, env: f.env }); await app.ready;
    await assert.rejects(startContainer({ data: f.data, env: f.env }), /another live process/);
    await app.stop(); app = null;
    const name = 'cube-agent-zero-foreign';
    await writeFile(path.join(f.data, 'cube-container.json'), JSON.stringify({ pid: 2147483000, name, token: 'expected-owner' }));
    await writeFile(path.join(f.dir, 'container.json'), JSON.stringify({ name, token: 'foreign-owner' }));
    await assert.rejects(startContainer({ data: f.data, env: f.env }), /not owned/);
    assert.notEqual(await readFile(path.join(f.dir, 'stopped'), 'utf8'), name);
  } finally { await app?.stop(); await f.close(); }
});
