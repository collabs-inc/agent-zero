import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ensureDocker } from './ensure-docker.mjs';
import { IMAGE, dockerCommand } from './container.mjs';

if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This pinned Agent Zero image requires Linux amd64.');
const config = await ensureDocker();
let pull;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true; pull?.kill('SIGTERM');
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
  // Cube installs an update while the previous app is still running. Starting
  // a warm container here would contend for its lock/data. The bounded startup
  // page handles cold initialization after Cube switches the foreground app.
  console.log('Agent Zero image is ready.');
} catch (error) { console.error(error.message); await stop(1); }
