import fs from 'node:fs/promises';
import path from 'node:path';
import { deleteWindowsBinary, ensureWindowsPrivateDirectory, inspectWindowsPath,
  readWindowsBinary, readWindowsPrivateFile, writeWindowsPrivateFile } from './windows-security.mjs';

export const TRUST_VERSION = 1;

export function trustTuple(resolution) {
  return { version: TRUST_VERSION, projectRoot: resolution.projectRoot,
    projectId: resolution.projectId, url: resolution.destination.url,
    collection: resolution.destination.collection, apiKeyEnv: resolution.destination.apiKeyEnv,
    ...(resolution.destination.address === undefined ? {} : { address: resolution.destination.address }),
    ...(resolution.destination.allowPublic === true ? { allowPublic: true } : {}) };
}

export function sameTrustTuple(expected, actual) {
  return !!actual && Object.entries(expected).every(([key, value]) => actual[key] === value) &&
    ['address', 'allowPublic'].every(key =>
      Object.hasOwn(expected, key) === Object.hasOwn(actual, key) &&
      (!Object.hasOwn(expected, key) || actual[key] === expected[key]));
}

export function authorizeDestination(resolution, localTrust, readSecret) {
  if (resolution?.provider !== 'mem0' || !localTrust || typeof readSecret !== 'function') {
    return { kind: 'blocked', reason: 'trust_changed' };
  }
  const required = trustTuple(resolution);
  if (!sameTrustTuple(required, localTrust)) {
    return { kind: 'blocked', reason: 'trust_changed' };
  }
  const key = readSecret(required.apiKeyEnv);
  return typeof key === 'string' && key.trim()
    ? { kind: 'authorized', key }
    : { kind: 'blocked', reason: 'missing_key' };
}

export async function readLocalTrust(stateDir) {
  if (process.platform === 'win32') {
    const directory = await inspectWindowsPath(stateDir, 'directory');
    if (!directory.ok) return null;
    const file = await readWindowsPrivateFile(path.join(stateDir, 'trust.json'));
    if (!file.ok) return null;
    try { return JSON.parse(file.text); } catch { return null; }
  }
  try {
    const directory = await fs.lstat(stateDir);
    if (!directory.isDirectory() || (process.getuid && directory.uid !== process.getuid()) ||
        (directory.mode & 0o077)) return null;
    const file = path.join(stateDir, 'trust.json');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch { return null; }
}

export async function writeLocalTrust(stateDir, tuple) {
  if (process.platform === 'win32') {
    const directory = await ensureWindowsPrivateDirectory(stateDir);
    if (!directory.ok) throw new Error('unsafe trust directory');
    const file = path.join(stateDir, 'trust.json');
    const existing = await readWindowsPrivateFile(file);
    if (!existing.ok && existing.code !== 'missing') throw new Error('unsafe trust file');
    const text = JSON.stringify(tuple) + '\n';
    if (existing.ok && existing.text === text) return;
    // The helper has no replace: a crash between these steps leaves no trust, which fails closed.
    if (existing.ok) {
      const observed = await readWindowsBinary(file, { length: 1024 * 1024 });
      await deleteWindowsBinary(file, observed.fileId, observed.bytes);
    }
    const written = await writeWindowsPrivateFile(file, text);
    if (!written.ok) throw new Error('unsafe trust file');
    return;
  }
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const directory = await fs.lstat(stateDir);
  if (!directory.isDirectory() || (process.getuid && directory.uid !== process.getuid()) ||
      (directory.mode & 0o077)) throw new Error('unsafe trust directory');
  const file = path.join(stateDir, 'trust.json');
  try {
    const existing = await fs.lstat(file);
    if (!existing.isFile() || (process.getuid && existing.uid !== process.getuid()) ||
        (existing.mode & 0o077)) throw new Error('unsafe trust file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(tuple) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}
