import { spawnSync } from 'node:child_process';
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

function matches(cli, output, command, args) {
  if (cli === 'codex') {
    let entry;
    try { entry = JSON.parse(output); } catch { return false; }
    const transport = entry.transport;
    return entry.enabled === true && transport?.type === 'stdio' &&
      transport.command === command && JSON.stringify(transport.args) === JSON.stringify(args) &&
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
    fields.Command === command && fields.Args === args.join(' ') && !environment;
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
    return matches(cli, found.stdout, process.execPath, args)
      ? { kind: 'existing' } : unavailable('mcp_conflict', cli, projectRoot);
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
    matches(cli, verified.stdout, process.execPath, args)
    ? { kind: 'registered' } : unavailable('mcp_registration_failed', cli, projectRoot);
}
