import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { ensureDocker } from './ensure-docker.mjs';
import { IMAGE, dockerCommand } from './container.mjs';

if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This pinned Agent Zero image requires Linux amd64.');
const config = await ensureDocker();
let pull;
let warm;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true; pull?.kill('SIGTERM'); warm?.kill('SIGTERM');
  if (warm) await once(warm, 'exit').catch(() => {});
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => void stop(1));
try {
  try { await dockerCommand(config, ['image', 'inspect', IMAGE]); }
  catch {
    pull = spawn(config.docker, ['--host', config.socket, 'pull', '--platform=linux/amd64', IMAGE], { env: config.env, stdio: 'inherit' });
    const [code] = await once(pull, 'exit'); pull = null;
    if (code !== 0) throw new Error('Agent Zero image download failed.');
  }
  console.log('Warming Agent Zero against its persistent data directory...');
  warm = spawn('sh', [fileURLToPath(new URL('./run.sh', import.meta.url)), '--warm'], { env: process.env, stdio: 'inherit' });
  const [code] = await once(warm, 'exit'); warm = null;
  if (code !== 0) throw new Error('Agent Zero first-run preparation failed.');
  console.log('Agent Zero image and persistent data are ready.');
} catch (error) { console.error(error.message); await stop(1); }
