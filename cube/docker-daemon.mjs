import path from 'node:path';
import { spawn } from 'node:child_process';
import { dockerConfig } from './ensure-docker.mjs';
import { boundedLog } from './bounded-log.mjs';

const config = dockerConfig();
const log = boundedLog(path.join(config.runtime, 'cube-dockerd.log'));
const child = spawn(config.rootless, ['--host', config.socket, '--data-root', path.join(config.home, '.local/share/docker')], {
  env: config.env, stdio: ['ignore', 'pipe', 'pipe'],
});
// If a disk is full, continue draining without crashing the daemon's log pipe.
const append = bytes => { try { log(bytes); } catch {} };
child.stdout.on('data', append); child.stderr.on('data', append);
child.on('error', error => { append(`Cannot start rootless Docker: ${error.message}\n`); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
