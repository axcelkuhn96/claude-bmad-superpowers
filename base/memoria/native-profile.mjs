import os from 'node:os';
import path from 'node:path';

export function nativeProfile(cli, env = process.env) {
  if (!['claude', 'codex'].includes(cli)) return null;
  const key = cli === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
  return env[key] === undefined ? path.join(os.homedir(), cli === 'codex' ? '.codex' : '.claude') : env[key];
}
