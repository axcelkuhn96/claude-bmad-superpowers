import path from 'node:path';
import os from 'node:os';
import { ensureWindowsPrivateDirectory, hashWindowsFile, holdWindowsHash,
  inspectWindowsPath, publishWindowsBinary, readWindowsBinary, windowsPathKey } from './windows-security.mjs';

const names = new Set(['claude', 'codex', 'python']);
const forbidden = (candidate, roots) => roots.some(root => {
  const key = windowsPathKey(root);
  return candidate === key || candidate.startsWith(key + '\\');
});
const recordFile = (stateRoot, name) => path.win32.join(stateRoot ??
  path.win32.join(os.homedir(), '.local', 'state', 'cbs', 'memoria'), 'enrollment', `${name}.json`);

export async function enrollWindowsTool({ stateRoot, name, executable, sha256,
  projectRoot, activeRoot, productRoot } = {}) {
  if (!names.has(name) || !/^[a-f0-9]{64}$/.test(sha256 ?? '') ||
      typeof executable !== 'string' || !executable.toLowerCase().endsWith('.exe')) {
    throw new Error('windows_enrollment_args');
  }
  const key = windowsPathKey(executable);
  if (forbidden(key, [projectRoot, activeRoot, productRoot].filter(Boolean))) {
    throw new Error('windows_enrollment_forbidden');
  }
  const audit = await inspectWindowsPath(executable, 'file', { privateState: false });
  if (!audit.ok) throw new Error('windows_enrollment_unsafe');
  const identity = await hashWindowsFile(executable, { privateState: false });
  if (identity.sha256 !== sha256) throw new Error('windows_enrollment_changed');
  const dir = path.win32.dirname(recordFile(stateRoot, name));
  if (!(await ensureWindowsPrivateDirectory(dir)).ok) throw new Error('windows_enrollment_state');
  const record = { version: 1, name, executable: key, fileId: identity.fileId,
    sha256, size: identity.size, ownerSid: audit.currentSid };
  await publishWindowsBinary(recordFile(stateRoot, name), Buffer.from(JSON.stringify(record) + '\n'));
  return record;
}

export async function resolveEnrolledWindowsTool({ stateRoot, name,
  projectRoot, activeRoot, productRoot } = {}) {
  if (!names.has(name)) throw new Error('windows_enrollment_args');
  const observed = await readWindowsBinary(recordFile(stateRoot, name), { length: 8192 });
  if (observed.size !== observed.bytes.length) throw new Error('windows_enrollment_unsafe');
  let record;
  try { record = JSON.parse(observed.bytes.toString('utf8')); }
  catch { throw new Error('windows_enrollment_unsafe'); }
  if (record?.version !== 1 || record.name !== name ||
      !/^[a-f0-9]{64}$/.test(record.sha256 ?? '') ||
      !/^[a-f0-9]{8}:[a-f0-9]{16}$/.test(record.fileId ?? '') ||
      !/^S-\d+(?:-\d+){2,}$/.test(record.ownerSid ?? '')) {
    throw new Error('windows_enrollment_unsafe');
  }
  const key = windowsPathKey(record.executable);
  if (forbidden(key, [projectRoot, activeRoot, productRoot].filter(Boolean))) {
    throw new Error('windows_enrollment_forbidden');
  }
  const audit = await inspectWindowsPath(record.executable, 'file', { privateState: false });
  if (!audit.ok || audit.currentSid !== record.ownerSid) throw new Error('windows_enrollment_changed');
  const current = await hashWindowsFile(record.executable, { privateState: false });
  if (current.fileId !== record.fileId || current.sha256 !== record.sha256 ||
      current.size !== record.size) throw new Error('windows_enrollment_changed');
  const release = await holdWindowsHash(record.executable, record.fileId, record.sha256,
    { privateState: false });
  return { executable: record.executable, release, record };
}
