import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

async function git(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const { stdout } = await runFile('git', ['-C', cwd, ...args], { env, timeout: 5000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

export async function identifyProject(cwd) {
  let realCwd;
  try { realCwd = await fs.realpath(cwd); } catch { return { kind: 'invalid_cwd' }; }
  let activeRoot;
  try { activeRoot = await fs.realpath(await git(realCwd, 'rev-parse', '--show-toplevel')); }
  catch { return { kind: 'non_git', cwd: realCwd }; }
  if (path.relative(activeRoot, realCwd).startsWith('..' + path.sep) ||
      path.relative(activeRoot, realCwd) === '..' || path.isAbsolute(path.relative(activeRoot, realCwd))) {
    return { kind: 'unsupported_git' };
  }
  try {
    if (await git(realCwd, 'rev-parse', '--is-bare-repository') !== 'false') return { kind: 'unsupported_git' };
    const lines = (await git(realCwd, 'worktree', 'list', '--porcelain')).split('\n');
    const listed = lines.filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9));
    if (!listed.length) return { kind: 'unsupported_git' };
    const roots = await Promise.all(listed.map((root) => fs.realpath(root).catch(() => null)));
    if (!roots.includes(activeRoot) || !roots[0]) return { kind: 'unsupported_git' };
    const projectRoot = roots[0];
    const uid = process.getuid?.();
    if (projectRoot === await fs.realpath(os.homedir()) || (uid !== undefined &&
      ((await fs.stat(projectRoot)).uid !== uid || (await fs.stat(activeRoot)).uid !== uid))) {
      return { kind: 'unsupported_git' };
    }
    return { kind: 'git', projectRoot, activeRoot };
  } catch { return { kind: 'unsupported_git' }; }
}
