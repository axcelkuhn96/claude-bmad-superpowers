import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const version = /^\d+\.\d+\.\d+$/;
const blocked = () => ({ kind: 'blocked', reason: 'cli_executable_untrusted' });

async function trustedDirectory(directory) {
  const stat = await fs.lstat(directory);
  return stat.isDirectory() && stat.uid === process.getuid() &&
    !(stat.mode & 0o022) && await fs.realpath(directory) === directory;
}

// Resolve only a removed version from the same user-owned Claude installation.
// The policy and frozen session retain their selected path and consent.
export async function resolveClaudeExecutable(selected) {
  if (process.platform === 'win32' || !process.getuid ||
      typeof selected !== 'string' || !path.isAbsolute(selected)) return blocked();
  try {
    let file;
    try { file = await fs.lstat(selected); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (file) {
      if (!file.isFile() || file.mode & 0o022 ||
          await fs.realpath(selected) !== selected) return blocked();
      return { kind: 'resolved', executable: selected, updated: false };
    }

    const home = await fs.realpath(os.homedir());
    const local = path.join(home, '.local');
    const share = path.join(local, 'share');
    const claude = path.join(share, 'claude');
    const versions = path.join(claude, 'versions');
    const bin = path.join(local, 'bin');
    if (path.dirname(selected) !== versions || !version.test(path.basename(selected)) ||
        !await trustedDirectory(home) || !await trustedDirectory(local) ||
        !await trustedDirectory(share) || !await trustedDirectory(claude) ||
        !await trustedDirectory(versions) || !await trustedDirectory(bin)) return blocked();
    const launcher = path.join(bin, 'claude');
    const link = await fs.lstat(launcher);
    if (!link.isSymbolicLink() || link.uid !== process.getuid()) return blocked();
    const executable = await fs.realpath(launcher);
    if (path.dirname(executable) !== versions || !version.test(path.basename(executable))) return blocked();
    const target = await fs.lstat(executable);
    if (!target.isFile() || target.uid !== process.getuid() ||
        (target.mode & 0o022) || !(target.mode & 0o100)) return blocked();
    return { kind: 'resolved', executable, updated: true };
  } catch { return blocked(); }
}
