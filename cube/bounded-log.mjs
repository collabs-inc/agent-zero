import { appendFileSync, existsSync, renameSync, statSync, writeFileSync } from 'node:fs';

// One current file plus one rotated file, each at most maxBytes. The daemon
// runner drains both pipes continuously, so logging cannot block dockerd.
export function boundedLog(file, maxBytes = 1024 * 1024) {
  let size = existsSync(file) ? statSync(file).size : 0;
  return bytes => {
    const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    for (let offset = 0; offset < input.length;) {
      if (size >= maxBytes) {
        renameSync(file, `${file}.1`);
        writeFileSync(file, '', { mode: 0o600 }); size = 0;
      }
      const chunk = input.subarray(offset, offset + maxBytes - size);
      appendFileSync(file, chunk, { mode: 0o600 });
      size += chunk.length; offset += chunk.length;
    }
  };
}
