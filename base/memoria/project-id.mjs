import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { canonicalWindowsPath, resolveWindowsExecutable, windowsPathKey } from './windows-security.mjs';

const runFile = promisify(execFile);

async function git(cwd, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  let executable = 'git';
  if (process.platform === 'win32') {
    let boundary = cwd;
    let gitMarker;
    for (let current = cwd; ; current = path.dirname(current)) {
      try {
        gitMarker = await fs.lstat(path.join(current, '.git'));
        boundary = current;
        break;
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (path.dirname(current) === current) break;
    }
    const forbidden = [boundary, fileURLToPath(new URL('../..', import.meta.url))];
    if (gitMarker?.isFile()) {
      if (gitMarker.size > 4096) throw new Error('unsupported_git');
      const marker = await fs.readFile(path.join(boundary, '.git'), 'utf8');
      const match = /^gitdir:\s*(.+)\s*$/i.exec(marker.trim());
      if (!match) throw new Error('unsupported_git');
      const gitdir = path.win32.resolve(boundary, match[1]);
      const parts = windowsPathKey(gitdir).split('\\.git\\worktrees\\');
      if (parts.length === 2 && parts[0]) forbidden.push(parts[0]);
    }
    executable = await resolveWindowsExecutable('git.exe',
      forbidden);
  }
  const commandArgs = process.platform === 'win32'
    ? ['-c', 'core.fsmonitor=false', '-C', cwd, ...args] : ['-C', cwd, ...args];
  const { stdout } = await runFile(executable, commandArgs, { env, timeout: 5000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

export async function identifyProject(cwd) {
  const canonical = process.platform === 'win32' ? canonicalWindowsPath : fs.realpath;
  let realCwd;
  try { realCwd = await canonical(cwd); } catch { return { kind: 'invalid_cwd' }; }
  let activeRoot;
  let gitRoot;
  try { gitRoot = await git(realCwd, 'rev-parse', '--show-toplevel'); }
  catch { return { kind: 'non_git', cwd: realCwd }; }
  try { activeRoot = await canonical(gitRoot); }
  catch { return { kind: 'unsupported_git' }; }
  if (path.relative(activeRoot, realCwd).startsWith('..' + path.sep) ||
      path.relative(activeRoot, realCwd) === '..' || path.isAbsolute(path.relative(activeRoot, realCwd))) {
    return { kind: 'unsupported_git' };
  }
  try {
    if (await git(realCwd, 'rev-parse', '--is-bare-repository') !== 'false') return { kind: 'unsupported_git' };
    const lines = (await git(realCwd, 'worktree', 'list', '--porcelain')).split('\n');
    const listed = lines.filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9));
    if (!listed.length) return { kind: 'unsupported_git' };
    const roots = await Promise.all(listed.map((root) => canonical(root).catch(() => null)));
    if (!roots.includes(activeRoot) || !roots[0]) return { kind: 'unsupported_git' };
    const projectRoot = roots[0];
    const uid = process.getuid?.();
    const home = process.platform === 'win32' ? windowsPathKey(await fs.realpath(os.homedir())) : await fs.realpath(os.homedir());
    if (projectRoot === home || (uid !== undefined &&
      ((await fs.stat(projectRoot)).uid !== uid || (await fs.stat(activeRoot)).uid !== uid))) {
      return { kind: 'unsupported_git' };
    }
    return { kind: 'git', projectRoot, activeRoot };
  } catch { return { kind: 'unsupported_git' }; }
}
