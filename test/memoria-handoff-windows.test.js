import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

if (process.env.CBS_WINDOWS_HANDOFF_TEST_CHILD !== '1') {
  test('Windows handoff simulation runs with module mocks when supported', t => {
    const flag = '--experimental-test-module-mocks';
    const probe = spawnSync(process.execPath, [flag, '-e',
      "if (typeof require('node:test').mock?.module !== 'function') process.exit(2)"], { encoding: 'utf8' });
    if (probe.status === 2 || /bad option: --experimental-test-module-mocks/.test(probe.stderr)) {
      t.skip(`module mocks unavailable on ${process.version}: ${probe.stderr.trim() || `exit ${probe.status}`}`);
      return;
    }
    assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const run = spawnSync(process.execPath, [flag, '--test', fileURLToPath(import.meta.url)], {
      encoding: 'utf8',
      env: { ...env, CBS_WINDOWS_HANDOFF_TEST_CHILD: '1' },
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /WINDOWS_HANDOFF_SIMULATION_EXECUTED/);
  });
} else {

const { mock } = test;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const privateDirectory = async dir => {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  return { ok: stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077) };
};
const inspectedDirectory = async dir => {
  try {
    const stat = await fs.lstat(dir);
    return { ok: stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & 0o077) };
  } catch (error) { return { ok: false, code: error.code === 'ENOENT' ? 'missing' : 'unsafe' }; }
};
const readBinary = async (file, { length } = {}) => {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077) throw Error('unsafe');
  const bytes = await fs.readFile(file);
  return { bytes: bytes.subarray(0, length), size: bytes.length, fileId: String(stat.ino) };
};
const publishBinary = async (file, bytes) => {
  await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
};
const deleteBinary = async (file, fileId, bytes) => {
  const observed = await readBinary(file);
  if (observed.fileId !== fileId || !observed.bytes.equals(bytes)) throw Error('changed');
  await fs.unlink(file);
};
const stateFor = file => ({
  async read() {
    try { return JSON.parse((await readBinary(file)).bytes.toString()); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  },
  async write(value) {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, bytes, { mode: 0o600 });
    await fs.rename(tmp, file);
  },
});

mock.module('../base/memoria/windows-security.mjs', { exports: {
  ensureWindowsPrivateDirectory: privateDirectory,
  inspectWindowsPath: inspectedDirectory,
  readWindowsBinary: readBinary,
  publishWindowsBinary: publishBinary,
  deleteWindowsBinary: deleteBinary,
  withWindowsFileLock: async (_file, callback) => callback({ fileId: 'fixture' }),
  windowsPathKey: value => value.toLowerCase(),
} });
mock.module('../base/memoria/windows-state.mjs', { exports: { createWindowsState: stateFor } });
const platform = Object.getOwnPropertyDescriptor(process, 'platform');
Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
const { captureHandoffIdentity, saveHandoff, prepareHandoff, acknowledgeHandoff } =
  await import('../base/memoria/handoff-state.mjs');
const { recordSessionCheckout } = await import('../base/memoria/session-checkout.mjs');
Object.defineProperty(process, 'platform', platform);

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null',
  '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
  '-C', cwd, ...args], { encoding: 'utf8' }).trim();

test('Windows handoff uses private transport and acknowledges only after delivery', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-win-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const state = path.join(root, 'state');
  await fs.mkdir(repo);
  git(repo, 'init', '-q');
  await fs.writeFile(path.join(repo, 'a'), 'a');
  git(repo, 'add', 'a'); git(repo, 'commit', '-qm', 'initial');
  const identity = async sourceSessionId => captureHandoffIdentity({ projectId: 'p', ownerId: 'o',
    nativeRoot: repo, projectRoot: repo, cli: 'codex', sourceSessionId });
  const source = await identity('source');
  const target = await identity('target');
  const handoff = { markdown: '## Objetivo\nContinuar trabalho.\n', summary: 'Continuar trabalho.',
    sourceHash: sha('capture') };
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    const checkout = await recordSessionCheckout({ stateDir: state, projectRoot: repo,
      projectId: 'p', ownerId: 'o' }, 'codex', 'source', repo, repo);
    assert.equal(checkout.kind, 'bound', JSON.stringify(checkout));
    assert.equal(checkout.handoffIdentity?.sourceSessionId, 'source');
    await fs.writeFile(path.join(repo, 'next'), 'next');
    git(repo, 'add', 'next'); git(repo, 'commit', '-qm', 'next');
    assert.equal((await recordSessionCheckout({ stateDir: state, projectRoot: repo,
      projectId: 'p', ownerId: 'o' }, 'codex', 'source', repo, repo)).kind, 'bound');
    assert.equal((await saveHandoff(state, { identity: source, handoff, event: 'SessionEnd',
      at: '2026-10-22T12:00:00.000Z' })).kind, 'saved');
    const selected = await prepareHandoff(state,
      { ...target, now: '2026-10-22T12:01:00.000Z' });
    assert.equal(selected.kind, 'prepared', JSON.stringify(selected));
    assert.equal(await fs.readFile(selected.file, 'utf8'), handoff.markdown);
    assert.equal((await fs.stat(selected.file)).mode & 0o077, 0);
    assert.equal((await acknowledgeHandoff(state, selected.receipt)).kind, 'acked');
    assert.equal((await prepareHandoff(state,
      { ...target, now: '2026-10-22T12:01:00.000Z' })).kind, 'deduped');
    await fs.chmod(path.join(state, 'handoff-auto'), 0o755);
    assert.equal((await prepareHandoff(state,
      { ...target, now: '2026-10-22T12:01:00.000Z' })).reason, 'unsafe_state');
    console.log('WINDOWS_HANDOFF_SIMULATION_EXECUTED');
  } finally { Object.defineProperty(process, 'platform', platform); }
});
}
