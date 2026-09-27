// Etapa AgentShield do gate: roda só quando o diff toca config de agente; ausente = parcial; alta/crítica = achado.
// O binário falso imprime o shape verificado de `agentshield scan --format json` (ecc-agentshield 1.6.0):
// { timestamp, targetPath, findings: [{ id, severity, category, title, description, file }], summary, ... }
// Exit real: 0 = sem crítico · 2 = há crítico · 1 = erro de uso/execução.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gate = path.join(RAIZ, 'base', 'scripts', 'gate-seguranca.js');
const TEM_GITLEAKS = spawnSync('gitleaks', ['version'], { encoding: 'utf8' }).status === 0;
const opts = { skip: (!TEM_GITLEAKS && 'gitleaks ausente no PATH') || (process.platform === 'win32' && 'POSIX') };
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const semAgentshield = () => (process.env.PATH || '').split(path.delimiter).filter((d) => d && !fs.existsSync(path.join(d, 'agentshield'))).join(path.delimiter);

function saidaFalsa(severidades) {
  const findings = severidades.map((severity, i) => ({
    id: `r${i}`, severity, category: 'permissions', title: 'x', description: 'x', file: '.claude/settings.json',
  }));
  const summary = { totalFindings: findings.length };
  for (const s of ['critical', 'high', 'medium', 'low', 'info']) summary[s] = severidades.filter((x) => x === s).length;
  return JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', targetPath: '/x', findings, score: {}, summary, defenses: [] });
}
function cenario(t, arquivoTocado, severidades, { saida = saidaFalsa(severidades), exit = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ags-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ags-home-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ags-bin-'));
  t.after(() => { for (const p of [root, home, bin]) fs.rmSync(p, { recursive: true, force: true }); });
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.email', 'gate@example.test');
  git(root, 'config', 'user.name', 'Gate test');
  fs.writeFileSync(path.join(root, 'README.md'), 'x\n');
  git(root, 'add', '-A'); git(root, 'commit', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  const alvo = path.join(root, arquivoTocado);
  fs.mkdirSync(path.dirname(alvo), { recursive: true });
  fs.writeFileSync(alvo, '{}\n');
  git(root, 'add', '-A'); git(root, 'commit', '-m', 'muda');
  const log = path.join(bin, 'chamadas.log');
  const json = path.join(bin, 'saida.json');
  fs.writeFileSync(json, saida);
  fs.writeFileSync(path.join(bin, 'agentshield'), `#!/bin/sh\necho "$@" >> "${log}"\ncat "${json}"\nexit ${exit}\n`, { mode: 0o755 });
  return { root, home, bin, base, log };
}
function rodar(c, pathEnv) {
  return spawnSync(process.execPath, [gate, c.root, '--base', c.base, '--saida', path.join(c.root, 'reports')], {
    cwd: c.root, encoding: 'utf8', env: { ...process.env, HOME: c.home, USERPROFILE: c.home, PATH: pathEnv },
  });
}

test('diff toca .claude/ e há achado alto → reprova e grava a saída', opts, (t) => {
  const c = cenario(t, '.claude/settings.json', ['high', 'low']);
  const r = rodar(c, `${c.bin}${path.delimiter}${semAgentshield()}`);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /✗ agentshield: 1 achado\(s\) alto\/crítico/);
  assert.ok(fs.existsSync(path.join(c.root, 'reports', 'agentshield.json')));
  assert.equal(fs.readFileSync(c.log, 'utf8').trim(), 'scan --format json --path .');
});
test('achado crítico com exit 2 (contrato real) → conta, não vira erro', opts, (t) => {
  const c = cenario(t, 'hooks/pre.sh', ['critical', 'high', 'info'], { exit: 2 });
  const r = rodar(c, `${c.bin}${path.delimiter}${semAgentshield()}`);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /✗ agentshield: 2 achado\(s\) alto\/crítico/);
  assert.doesNotMatch(r.stdout, /agentshield: erro/);
});
test('diff toca AGENTS.md só com achados baixos → não soma achado', opts, (t) => {
  const c = cenario(t, 'AGENTS.md', ['low', 'medium', 'info']);
  const r = rodar(c, `${c.bin}${path.delimiter}${semAgentshield()}`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /✗ agentshield/);
  assert.match(r.stdout, /✓ agentshield: sem achado alto\/crítico/);
});
test('diff sem config de agente → agentshield não roda', opts, (t) => {
  const c = cenario(t, 'src/app.js', ['critical']);
  const r = rodar(c, `${c.bin}${path.delimiter}${semAgentshield()}`);
  assert.match(r.stdout, /^GATE: /m);
  assert.doesNotMatch(r.stdout, /agentshield/);
  assert.equal(fs.existsSync(c.log), false);
});
test('agentshield ausente → gate parcial com a instrução de instalação', opts, (t) => {
  const c = cenario(t, '.mcp.json', []);
  const r = rodar(c, semAgentshield());
  assert.match(r.stdout, /agentshield: não instalado — gate parcial \(npm i -g ecc-agentshield\)/);
  assert.match(r.stdout, /APROVADO COM RESSALVAS — .*agentshield/);
});
test('saída ilegível ou sem findings → erro, gate parcial', opts, (t) => {
  for (const [saida, exit] of [['Error: Path does not exist', 1], ['{"summary":{}}', 0]]) {
    const c = cenario(t, 'CLAUDE.md', [], { saida, exit });
    const r = rodar(c, `${c.bin}${path.delimiter}${semAgentshield()}`);
    assert.match(r.stdout, /⚠ agentshield: erro \(exit \d+, saída ilegível\)/);
    assert.ok(fs.existsSync(path.join(c.root, 'reports', 'agentshield.err')));
  }
});
test('nunca chama o modo --opus', opts, (t) => {
  const c = cenario(t, '.codex/config.toml', []);
  rodar(c, `${c.bin}${path.delimiter}${semAgentshield()}`);
  assert.doesNotMatch(fs.readFileSync(c.log, 'utf8'), /--opus|--deep|--injection|--sandbox|--supply-chain-online/);
});
