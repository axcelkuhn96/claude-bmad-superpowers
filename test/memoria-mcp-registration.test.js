import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerReadonlyMcp } from '../base/memoria/mcp-register.mjs';

const mcpScript = fileURLToPath(new URL('../base/memoria/mcp-readonly.mjs', import.meta.url));

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbs-mcp-register-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  const project = path.join(dir, 'project');
  const profile = path.join(dir, 'profile');
  await Promise.all([fs.mkdir(bin), fs.mkdir(project), fs.mkdir(profile)]);
  const fake = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const cli = path.basename(process.argv[1]);
const home = cli === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
const file = path.join(home, 'servers.json');
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { other: { command: 'other' } };
const log = path.join(home, 'calls.json');
const calls = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : [];
const args = process.argv.slice(2);
calls.push({ cli, args, cwd: process.cwd(), home });
fs.writeFileSync(log, JSON.stringify(calls));
if (process.env.FAKE_MCP_FAIL === args[1]) process.exit(9);
if (args[0] !== 'mcp') process.exit(2);
if (args[1] === 'get') {
  const value = state.cbs_memoria;
  if (!value) {
    process.stderr.write(cli === 'claude' ? 'No MCP server named "cbs_memoria". Run claude mcp add to add one.\\n' : "Error: No MCP server named 'cbs_memoria' found.\\n");
    process.exit(1);
  }
  if (cli === 'codex') process.stdout.write(JSON.stringify({ name: 'cbs_memoria', enabled: true, transport: { type: 'stdio', command: value.command, args: value.args, env: null } }));
  else process.stdout.write('cbs_memoria:\\n  Scope: ' + (value.scope === 'local' ? 'Local config (private to you in this project)' : 'User config') + '\\n  Type: stdio\\n  Command: ' + value.command + '\\n  Args: ' + value.args.join(' ') + '\\n');
  process.exit(0);
}
if (args[1] === 'add') {
  if (state.cbs_memoria) process.exit(4);
  const scope = cli === 'claude' ? args[3] : 'global';
  const separator = args.indexOf('--');
  state.cbs_memoria = { scope, command: args[separator + 1], args: args.slice(separator + 2) };
  fs.writeFileSync(file, JSON.stringify(state));
  if (cli === 'codex' && !fs.existsSync(path.join(home, 'config.toml')))
    fs.writeFileSync(path.join(home, 'config.toml'), '[mcp_servers.cbs_memoria]\\ncommand = "node"\\nargs = []\\n');
  process.exit(0);
}
process.exit(2);
`;
  for (const cli of ['claude', 'codex']) {
    const file = path.join(bin, cli);
    await fs.writeFile(file, fake, { mode: 0o755 });
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`,
    CLAUDE_CONFIG_DIR: profile, CODEX_HOME: profile };
  const state = async () => JSON.parse(await fs.readFile(path.join(profile, 'servers.json'), 'utf8'));
  const calls = async () => JSON.parse(await fs.readFile(path.join(profile, 'calls.json'), 'utf8'));
  return { dir, project, profile, env, state, calls };
}

test('Codex exposes remember and preserves unrelated TOML byte for byte', async t => {
  const f = await fixture(t);
  const config = path.join(f.profile, 'config.toml');
  const other = '[other]\nvalue = "keep me"\n\n';
  await fs.writeFile(config, `${other}[mcp_servers.cbs_memoria]\ncommand = "node"\nargs = []\n\n[tail]\nx = 1\n`);
  assert.equal((await registerReadonlyMcp(f.project, 'codex', { env: f.env })).kind, 'registered');
  const after = await fs.readFile(config, 'utf8');
  assert.ok(after.startsWith(other));
  assert.ok(after.endsWith('[tail]\nx = 1\n'));
  assert.match(after, /\[mcp_servers\.cbs_memoria\][\s\S]*enabled_tools = \["search", "get", "status", "remember"\]/);
  assert.match(after, /\[mcp_servers\.cbs_memoria\][\s\S]*default_tools_approval_mode = "writes"/);
  assert.equal((await registerReadonlyMcp(f.project, 'codex', { env: f.env })).kind, 'existing');
  assert.equal(await fs.readFile(config, 'utf8'), after);
  assert.ok((await f.calls()).every(call => !call.args.includes('-c')));
});

test('Codex migrates the exact legacy allowlist and leaves conflicting servers unchanged', async t => {
  const f = await fixture(t);
  const config = path.join(f.profile, 'config.toml');
  await fs.writeFile(config, '[mcp_servers.cbs_memoria]\nenabled_tools = ["search", "get", "status"]\ndefault_tools_approval_mode = "writes"\n');
  assert.equal((await registerReadonlyMcp(f.project, 'codex', { env: f.env })).kind, 'registered');
  assert.match(await fs.readFile(config, 'utf8'), /enabled_tools = \["search", "get", "status", "remember"\]/);
  assert.match(await fs.readFile(config, 'utf8'), /default_tools_approval_mode = "writes"/);
  const current = await fs.readFile(config, 'utf8');
  const state = await f.state();
  state.cbs_memoria.command = '/other';
  await fs.writeFile(path.join(f.profile, 'servers.json'), JSON.stringify(state));
  assert.equal((await registerReadonlyMcp(f.project, 'codex', { env: f.env })).reason, 'mcp_conflict');
  assert.equal(await fs.readFile(config, 'utf8'), current);
});

test('Codex leaves a customized tool allowlist and approval mode untouched', async t => {
  const f = await fixture(t);
  const config = path.join(f.profile, 'config.toml');
  const before = '[other]\nkeep = "yes"\n[mcp_servers.cbs_memoria]\nenabled_tools = ["search", "write"]\ndefault_tools_approval_mode = "approve"\n';
  await fs.writeFile(config, before);
  assert.equal((await registerReadonlyMcp(f.project, 'codex', { env: f.env })).reason, 'mcp_registration_failed');
  assert.equal(await fs.readFile(config, 'utf8'), before);
});

test('Codex does not replace a custom approval mode on an otherwise legacy policy', async t => {
  const f = await fixture(t);
  const config = path.join(f.profile, 'config.toml');
  const before = '[mcp_servers.cbs_memoria]\nenabled_tools = ["search", "get", "status"]\ndefault_tools_approval_mode = "approve"\n';
  await fs.writeFile(config, before);
  assert.equal((await registerReadonlyMcp(f.project, 'codex', { env: f.env })).reason, 'mcp_registration_failed');
  assert.equal(await fs.readFile(config, 'utf8'), before);
});

test('Codex fails closed if its owned TOML stanza is absent or ambiguous', async t => {
  const f = await fixture(t);
  const config = path.join(f.profile, 'config.toml');
  await fs.writeFile(config, '[other]\nx = 1\n');
  assert.equal((await registerReadonlyMcp(f.project, 'codex', { env: f.env })).reason, 'mcp_registration_failed');
  const state = await f.state();
  delete state.cbs_memoria;
  await fs.writeFile(path.join(f.profile, 'servers.json'), JSON.stringify(state));
  const duplicate = '[mcp_servers.cbs_memoria]\ncommand = "node"\n[mcp_servers.cbs_memoria]\ncommand = "node"\n';
  await fs.writeFile(config, duplicate);
  assert.equal((await registerReadonlyMcp(f.project, 'codex', { env: f.env })).reason, 'mcp_registration_failed');
  assert.equal(await fs.readFile(config, 'utf8'), duplicate);
});

test('Codex refuses an owned server with a per-tool approval override', async t => {
  const f = await fixture(t);
  const config = path.join(f.profile, 'config.toml');
  const before = '[mcp_servers.cbs_memoria]\ncommand = "node"\n[mcp_servers.cbs_memoria.tools.search]\napproval_mode = "approve"\n';
  await fs.writeFile(config, before);
  assert.equal((await registerReadonlyMcp(f.project, 'codex', { env: f.env })).reason, 'mcp_registration_failed');
  assert.equal(await fs.readFile(config, 'utf8'), before);
});

test('Claude registra MCP local no projeto, preserva terceiros e é idempotente', async t => {
  const f = await fixture(t);
  assert.equal((await registerReadonlyMcp(f.project, 'claude', { env: f.env })).kind, 'registered');
  const state = await f.state();
  assert.deepEqual(state.other, { command: 'other' });
  assert.deepEqual(state.cbs_memoria, { scope: 'local', command: process.execPath,
    args: [mcpScript, '--cli', 'claude', '--project', f.project] });
  assert.equal((await registerReadonlyMcp(f.project, 'claude', { env: f.env })).kind, 'existing');
  assert.equal((await f.calls()).filter(call => call.args[1] === 'add').length, 1);
  assert.ok((await f.calls()).every(call => call.cwd === f.project && call.home === f.profile));
});

test('Codex registra um MCP global por perfil com cwd dinâmico', async t => {
  const f = await fixture(t);
  const second = path.join(f.dir, 'second');
  await fs.mkdir(second);
  assert.equal((await registerReadonlyMcp(f.project, 'codex', { env: f.env })).kind, 'registered');
  assert.equal((await registerReadonlyMcp(second, 'codex', { env: f.env })).kind, 'existing');
  assert.deepEqual((await f.state()).cbs_memoria, { scope: 'global', command: process.execPath,
    args: [mcpScript, '--cli', 'codex'] });
  assert.equal((await f.calls()).filter(call => call.args[1] === 'add').length, 1);
});

test('Codex reconhece entrada legada node quando resolve ao mesmo runtime', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.profile, 'servers.json'), JSON.stringify({ other: { command: 'other' },
    cbs_memoria: { scope: 'global', command: 'node', args: [mcpScript, '--cli', 'codex'] } }));
  await fs.writeFile(path.join(f.profile, 'config.toml'), '[mcp_servers.cbs_memoria]\ncommand = "node"\n');
  assert.equal((await registerReadonlyMcp(f.project, 'codex', { env: f.env })).kind, 'existing');
  assert.match(await fs.readFile(path.join(f.profile, 'config.toml'), 'utf8'),
    /enabled_tools = \["search", "get", "status", "remember"\]/);
  assert.equal((await f.calls()).filter(call => call.args[1] === 'add').length, 0);
});

test('Claude reconhece entrada local manual com node quando resolve ao mesmo runtime', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.profile, 'servers.json'), JSON.stringify({
    cbs_memoria: { scope: 'local', command: 'node',
      args: [mcpScript, '--cli', 'claude', '--project', f.project] } }));
  assert.equal((await registerReadonlyMcp(f.project, 'claude', { env: f.env })).kind, 'existing');
  assert.equal((await f.calls()).filter(call => call.args[1] === 'add').length, 0);
});

test('Claude não aceita entrada global manual com node', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.profile, 'servers.json'), JSON.stringify({
    cbs_memoria: { scope: 'global', command: 'node',
      args: [mcpScript, '--cli', 'claude', '--project', f.project] } }));
  assert.equal((await registerReadonlyMcp(f.project, 'claude', { env: f.env })).reason, 'mcp_conflict');
});

test('node via symlink canônico é aceito sem executar a resolução', async t => {
  const f = await fixture(t);
  const links = path.join(f.dir, 'links');
  await fs.mkdir(links);
  await fs.symlink(process.execPath, path.join(links, 'node'));
  const env = { ...f.env, PATH: `${path.join(f.dir, 'bin')}${path.delimiter}${links}` };
  await fs.writeFile(path.join(f.profile, 'servers.json'), JSON.stringify({
    cbs_memoria: { scope: 'local', command: 'node',
      args: [mcpScript, '--cli', 'claude', '--project', f.project] } }));
  assert.equal((await registerReadonlyMcp(f.project, 'claude', { env })).kind, 'existing');
});

test('primeiro node no PATH absoluto ou relativo divergente é recusado sem executar wrapper', async t => {
  const f = await fixture(t);
  const wrapperDir = path.join(f.dir, 'wrapper');
  const realDir = path.join(f.dir, 'real');
  await Promise.all([fs.mkdir(wrapperDir), fs.mkdir(realDir)]);
  const marker = path.join(f.dir, 'wrapper-executed');
  await fs.writeFile(path.join(wrapperDir, 'node'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdout.write(${JSON.stringify(process.execPath)});\n`, { mode: 0o755 });
  await fs.symlink(process.execPath, path.join(realDir, 'node'));
  const env = { ...f.env, PATH: [path.join(f.dir, 'bin'), wrapperDir, realDir].join(path.delimiter) };
  await fs.writeFile(path.join(f.profile, 'servers.json'), JSON.stringify({
    cbs_memoria: { scope: 'global', command: 'node', args: [mcpScript, '--cli', 'codex'] } }));
  await fs.writeFile(path.join(f.profile, 'config.toml'), '[mcp_servers.cbs_memoria]\ncommand = "node"\n');
  assert.equal((await registerReadonlyMcp(f.project, 'codex', { env })).reason, 'mcp_conflict');
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
  const relativeEnv = { ...env, PATH: [path.join(f.dir, 'bin'), '../wrapper', realDir].join(path.delimiter) };
  assert.equal((await registerReadonlyMcp(f.project, 'codex', { env: relativeEnv })).reason, 'mcp_conflict');
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
});

test('node equivalente ainda exige script, args e papel do projeto exatos', async t => {
  const f = await fixture(t);
  for (const [cli, scope, args] of [
    ['claude', 'local', [mcpScript, '--cli', 'claude', '--project', f.project]],
    ['codex', 'global', [mcpScript, '--cli', 'codex']],
  ]) {
    for (const wrong of [
      { command: 'node', args: ['/other/script.mjs', ...args.slice(1)] },
      { command: 'node', args: [...args, '--extra'] },
      { command: 'other', args },
    ]) {
      await fs.writeFile(path.join(f.profile, 'servers.json'), JSON.stringify({
        cbs_memoria: { scope, ...wrong } }));
      assert.equal((await registerReadonlyMcp(f.project, cli, { env: f.env })).reason, 'mcp_conflict');
    }
  }
});

test('entrada divergente permanece intacta e recebe ação concreta', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.profile, 'servers.json'), JSON.stringify({
    other: { command: 'other' }, cbs_memoria: { scope: 'local', command: '/other', args: [] } }));
  const result = await registerReadonlyMcp(f.project, 'claude', { env: f.env });
  assert.equal(result.kind, 'unavailable');
  assert.equal(result.reason, 'mcp_conflict');
  assert.match(result.action, /claude mcp get cbs_memoria/);
  assert.equal((await f.state()).cbs_memoria.command, '/other');
  assert.equal((await f.calls()).filter(call => call.args[1] === 'add').length, 0);
});

test('falha ou ausência de CLI não relata MCP disponível', async t => {
  const f = await fixture(t);
  const failed = await registerReadonlyMcp(f.project, 'codex', { env: { ...f.env, FAKE_MCP_FAIL: 'add' } });
  assert.equal(failed.kind, 'unavailable');
  assert.match(failed.action, /cbs memoria activate/);
  assert.match(failed.action, /--project/);
  assert.ok(failed.action.includes(f.project));
  await assert.rejects(fs.access(path.join(f.profile, 'servers.json')), { code: 'ENOENT' });
  const missing = await registerReadonlyMcp(f.project, 'claude', { env: { ...f.env, PATH: '/nonexistent' } });
  assert.equal(missing.kind, 'unavailable');
  assert.match(missing.action, /Claude/);
});
