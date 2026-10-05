import { once } from 'node:events';
import { startContainer } from './container.mjs';
import { gateway } from './gateway.mjs';

const port = Number(process.env.PORT);
const warm = process.argv.includes('--warm');
if (!warm && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('PORT must be between 1 and 65535.');
let app, proxy, stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true; proxy?.close();
  try { await app?.stop({ timeout: warm ? 15000 : 1600 }); }
  catch (error) { console.error(error.message); code = 1; }
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => void stop());
try {
  app = await startContainer({ waitMs: 300000, onExit: error => { console.error(error.message); void stop(1); } });
  let ready = false;
  if (!warm) {
    proxy = gateway(app.innerPort, () => ready);
    proxy.server.listen(port, '127.0.0.1'); await once(proxy.server, 'listening');
    console.log('Starting Agent Zero services (up to five minutes on a cold volume)...');
  }
  await app.ready;
  if (warm) await stop();
  ready = true;
  console.log(`Agent Zero is ready on 127.0.0.1:${port}.`);
} catch (error) { console.error(error.message); await stop(1); }
