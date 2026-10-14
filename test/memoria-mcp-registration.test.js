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
  const fake = `#!/usr/bin/env node
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
  else process.stdout.write('cbs_memoria:\\n  Scope: Local config (private to you in this project)\\n  Type: stdio\\n  Command: ' + value.command + '\\n  Args: ' + value.args.join(' ') + '\\n');
  process.exit(0);
}
if (args[1] === 'add') {
  if (state.cbs_memoria) process.exit(4);
  const scope = cli === 'claude' ? args[3] : 'global';
  const separator = args.indexOf('--');
  state.cbs_memoria = { scope, command: args[separator + 1], args: args.slice(separator + 2) };
  fs.writeFileSync(file, JSON.stringify(state));
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
