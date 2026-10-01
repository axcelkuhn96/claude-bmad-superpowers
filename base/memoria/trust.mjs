import fs from 'node:fs/promises';
import path from 'node:path';

export const TRUST_VERSION = 1;

export function trustTuple(resolution) {
  return { version: TRUST_VERSION, projectRoot: resolution.projectRoot,
    projectId: resolution.projectId, url: resolution.destination.url,
    collection: resolution.destination.collection, apiKeyEnv: resolution.destination.apiKeyEnv };
}

export function authorizeDestination(resolution, localTrust, readSecret) {
  if (resolution?.provider !== 'mem0' || !localTrust || typeof readSecret !== 'function') {
    return { kind: 'blocked', reason: 'trust_changed' };
  }
  const required = trustTuple(resolution);
  if (Object.entries(required).some(([key, value]) => localTrust[key] !== value)) {
    return { kind: 'blocked', reason: 'trust_changed' };
  }
  const key = readSecret(required.apiKeyEnv);
  return typeof key === 'string' && key.trim()
    ? { kind: 'authorized', key }
    : { kind: 'blocked', reason: 'missing_key' };
}

export async function readLocalTrust(stateDir) {
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
