import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const keyEnv = 'CBS_MEMORIA_QDRANT_KEY';

export function readQdrantSecret(name, { env = process.env, homeDir = os.homedir() } = {}) {
  const supplied = env[name];
  if (typeof supplied === 'string' && supplied.trim()) return supplied;
  if (name !== keyEnv || process.platform === 'win32' || !process.getuid) return undefined;
  try {
    const directories = [homeDir, path.join(homeDir, '.config'),
      path.join(homeDir, '.config', 'cbs'), path.join(homeDir, '.config', 'cbs', 'memoria')];
    for (const [index, directory] of directories.entries()) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.uid !== process.getuid() ||
          (index > 0 && (stat.mode & 0o777) !== 0o700)) return undefined;
    }
    const file = path.join(directories.at(-1), 'qdrant-api-key');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.uid !== process.getuid() ||
        (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > 8192) return undefined;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino ||
          opened.uid !== process.getuid() || (opened.mode & 0o777) !== 0o600 ||
          opened.size < 1 || opened.size > 8192) return undefined;
      const buffer = Buffer.alloc(8193);
      const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (size < 1 || size > 8192) return undefined;
      const value = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))
        .replace(/\r?\n$/, '');
      return /^[!-~]+$/.test(value) ? value : undefined;
    } finally { fs.closeSync(fd); }
  } catch { return undefined; }
}
