import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./mcp-readonly.mjs', import.meta.url));
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const unavailable = (reason, cli, projectRoot) => ({ kind: 'unavailable', reason,
  action: reason === 'mcp_conflict'
    ? `Inspecione ${cli} mcp get cbs_memoria e resolva a entrada existente antes de repetir cbs memoria activate.`
    : `Verifique a CLI ${cli === 'claude' ? 'Claude' : 'Codex'} e repita cbs memoria activate --cli ${cli} --project ${shellQuote(projectRoot)}.` });

function run(cli, args, cwd, env) {
  return spawnSync(cli, args, { cwd, env, encoding: 'utf8', timeout: 15000, maxBuffer: 64 * 1024 });
}

async function matchesLauncher(actual, command, env, cwd) {
  if (actual === command) return true;
  if (actual !== 'node' || process.platform === 'win32' || typeof env.PATH !== 'string') return false;
  for (const entry of env.PATH.split(path.delimiter)) {
    const candidate = path.resolve(cwd, entry, 'node');
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
      await fs.access(candidate, fs.constants.X_OK);
      return await fs.realpath(candidate) === await fs.realpath(command);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) return false;
    }
  }
  return false;
}

async function matches(cli, output, command, args, env, cwd) {
  if (cli === 'codex') {
    let entry;
    try { entry = JSON.parse(output); } catch { return false; }
    const transport = entry.transport;
    const launcher = await matchesLauncher(transport?.command, command, env, cwd);
    return entry.enabled === true && transport?.type === 'stdio' &&
      launcher && JSON.stringify(transport.args) === JSON.stringify(args) &&
      !transport.cwd && (!transport.env || Object.keys(transport.env).length === 0) &&
      (!transport.env_vars || transport.env_vars.length === 0);
  }
  const lines = output.split('\n');
  const fields = Object.fromEntries(lines.map(line => /^  (Scope|Type|Command|Args|Environment):(?: (.*))?$/.exec(line))
    .filter(Boolean).map(match => [match[1], match[2] ?? '']));
  const environmentIndex = lines.findIndex(line => line === '  Environment:');
  const environment = environmentIndex < 0 ? null : lines.slice(environmentIndex + 1)
    .find(line => line.trim() && !line.startsWith('To remove'));
  return fields.Scope === 'Local config (private to you in this project)' && fields.Type === 'stdio' &&
    await matchesLauncher(fields.Command, command, env, cwd) && fields.Args === args.join(' ') && !environment;
}

const codexPolicy = [
  ['enabled_tools', '["search", "get", "status", "remember", "update", "delete"]'],
  ['default_tools_approval_mode', '"writes"'],
];
const legacyCodexTools = '["search","get","status"]';
const previousCodexTools = '["search","get","status","remember"]';
const currentCodexTools = '["search","get","status","remember","update","delete"]';

async function persistCodexPolicy(env) {
  const profile = env.CODEX_HOME ?? path.join(env.HOME ?? os.homedir(), '.codex');
  if (!path.isAbsolute(profile)) return false;
  const file = path.join(profile, 'config.toml');
  let temporary;
  try {
    const before = await fs.readFile(file, 'utf8');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const headers = [...before.matchAll(/^\s*\[([^\]\r\n]+)\][ \t]*(?:#.*)?$/gm)];
    const owned = headers.filter(match => match[1] === 'mcp_servers.cbs_memoria' ||
      match[1] === 'mcp_servers."cbs_memoria"');
    if (owned.length !== 1) return false;
    if (headers.some(match => match[1].startsWith('mcp_servers.cbs_memoria.tools.') ||
        match[1].startsWith('mcp_servers."cbs_memoria".tools.'))) return false;
    const header = owned[0];
    const next = headers.find(match => match.index > header.index);
    const start = header.index + header[0].length;
    const end = next?.index ?? before.length;
    let section = before.slice(start, end);
    if (/^[ \t]*tools(?:\.|[ \t]*=)/m.test(section)) return false;
    const newline = before.includes('\r\n') ? '\r\n' : '\n';
    for (const [key, value] of codexPolicy) {
      const pattern = new RegExp(`^([ \\t]*${key}[ \\t]*=[ \\t]*)([^\\r\\n]*)(\\r?\\n|$)`, 'gm');
      const matches = [...section.matchAll(pattern)];
      if (matches.length > 1) return false;
      if (matches.length === 1) {
        const current = matches[0][2].trim();
        if (key === 'enabled_tools') {
          let parsed;
          try { parsed = JSON.stringify(JSON.parse(current)); } catch { return false; }
          if (parsed !== legacyCodexTools && parsed !== previousCodexTools &&
              parsed !== currentCodexTools) return false;
        } else if (current !== value) return false;
        section = section.replace(pattern, `$1${value}$3`);
      } else {
        section = `${section}${section.endsWith(newline) || !section ? '' : newline}${key} = ${value}${newline}`;
      }
    }
    const after = before.slice(0, start) + section + before.slice(end);
    if (after === before) return true;
    temporary = path.join(profile, `.config.toml.cbs-${process.pid}-${Date.now()}`);
    await fs.writeFile(temporary, after, { mode: 0o600, flag: 'wx' });
    const now = await fs.lstat(file);
    if (now.ino !== stat.ino || now.size !== stat.size || now.mtimeMs !== stat.mtimeMs) return false;
    await fs.rename(temporary, file);
    temporary = undefined;
    return true;
  } catch { return false; }
  finally { if (temporary) await fs.rm(temporary, { force: true }).catch(() => {}); }
}

export async function registerReadonlyMcp(projectRoot, cli, { env = process.env } = {}) {
  if (!['claude', 'codex'].includes(cli)) return unavailable('invalid_cli', cli, projectRoot);
  const args = cli === 'claude'
    ? [script, '--cli', 'claude', '--project', projectRoot]
    : [script, '--cli', 'codex'];
  const getArgs = ['mcp', 'get', 'cbs_memoria', ...(cli === 'codex' ? ['--json'] : [])];
  const found = run(cli, getArgs, projectRoot, env);
  if (found.error) return unavailable('mcp_cli_unavailable', cli, projectRoot);
  if (found.status === 0) {
    if (!await matches(cli, found.stdout, process.execPath, args, env, projectRoot)) return unavailable('mcp_conflict', cli, projectRoot);
    if (cli === 'codex' && !await persistCodexPolicy(env)) return unavailable('mcp_registration_failed', cli, projectRoot);
    return { kind: 'existing' };
  }
  const missing = cli === 'claude'
    ? /No MCP server named "cbs_memoria"/.test(found.stderr)
    : /No MCP server named 'cbs_memoria' found/.test(found.stderr);
  if (!missing) return unavailable('mcp_cli_failed', cli, projectRoot);
  const addArgs = cli === 'claude'
    ? ['mcp', 'add', '--scope', 'local', 'cbs_memoria', '--', process.execPath, ...args]
    : ['mcp', 'add', 'cbs_memoria', '--', process.execPath, ...args];
  const added = run(cli, addArgs, projectRoot, env);
  if (added.error || added.status !== 0) return unavailable('mcp_registration_failed', cli, projectRoot);
  const verified = run(cli, getArgs, projectRoot, env);
  return !verified.error && verified.status === 0 &&
    await matches(cli, verified.stdout, process.execPath, args, env, projectRoot) &&
    (cli !== 'codex' || await persistCodexPolicy(env))
    ? { kind: 'registered' } : unavailable('mcp_registration_failed', cli, projectRoot);
}
