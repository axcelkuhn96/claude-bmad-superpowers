// Achados históricos revisados lidos de ~/.claude/cbs-overrides/gate-achados-revisados.json (por projeto).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gate = path.join(RAIZ, 'base', 'scripts', 'gate-seguranca.js');
const TEM_GITLEAKS = spawnSync('gitleaks', ['version'], { encoding: 'utf8' }).status === 0;
const opts = { skip: (!TEM_GITLEAKS && 'gitleaks ausente no PATH') || (process.platform === 'win32' && 'POSIX') };
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };

function cenario() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-revisados-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-revisados-home-'));
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.email', 'gate@example.test');
  git(root, 'config', 'user.name', 'Gate test');
  fs.writeFileSync(path.join(root, '.gitleaks.toml'), 'title = "t"\n[extend]\nuseDefault = true\n[[rules]]\nid = "synthetic-gate-test"\ndescription = "Synthetic"\nregex = \'\'\'SYNTHETIC_GATE_[A-Z_]+\'\'\'\nsecretGroup = 0\n');
  git(root, 'add', '-A'); git(root, 'commit', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  // Montado em tempo de execução: o literal casaria a regra sintética na varredura de histórico do próprio pacote.
  const linha = 'TOKEN=' + ['SYNTHETIC', 'GATE', 'REVIEWED', 'VALUE'].join('_');
  fs.writeFileSync(path.join(root, 'segredo.txt'), linha + '\n');
  git(root, 'add', '-A'); git(root, 'commit', '-m', 'vaza');
  const commit = git(root, 'rev-parse', 'HEAD');
  fs.rmSync(path.join(root, 'segredo.txt'));
  git(root, 'add', '-A'); git(root, 'commit', '-m', 'remove');
  const hash = sha([commit, 'segredo.txt', '1', 'synthetic-gate-test', sha(linha)].join('\0'));
  return { root, home, base, hash };
}
function rodarGate({ root, home, base }) {
  return spawnSync(process.execPath, [gate, root, '--base', base, '--saida', path.join(root, 'reports')], {
    cwd: root, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}
function gravarRevisados(home, conteudo) {
  const dir = path.join(home, '.claude', 'cbs-overrides');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'gate-achados-revisados.json'), typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo));
}
function limpar(t, c, ...extra) {
  t.after(() => { for (const p of [c.root, c.home, ...extra]) fs.rmSync(p, { recursive: true, force: true }); });
}

test('sem arquivo de revisados: achado histórico reprova', opts, (t) => {
  const c = cenario(); limpar(t, c);
  const r = rodarGate(c);
  assert.equal(r.status, 1, r.stdout + r.stderr);
});

test('hash revisado para ESTE projeto suprime o achado histórico', opts, (t) => {
  const c = cenario(); limpar(t, c);
  gravarRevisados(c.home, { [fs.realpathSync(c.root)]: [c.hash] });
  const r = rodarGate(c);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const revisados = JSON.parse(fs.readFileSync(path.join(c.root, 'reports', 'gitleaks-commits-reviewed.json'), 'utf8'));
  assert.equal(revisados.length, 1);
});

test('hash revisado de OUTRO projeto não suprime', opts, (t) => {
  const c = cenario(); limpar(t, c);
  // Chave de um diretório EXISTENTE e diferente do projeto: exercita a comparação real !== alvo.
  gravarRevisados(c.home, { [fs.realpathSync(c.home)]: [c.hash] });
  assert.equal(rodarGate(c).status, 1);
});

test('chave por symlink casa pelo caminho real', opts, (t) => {
  const c = cenario();
  const link = path.join(os.tmpdir(), `gate-revisados-link-${process.pid}-${Date.now()}`);
  fs.symlinkSync(c.root, link);
  limpar(t, c, link);
  gravarRevisados(c.home, { [link]: [c.hash] });
  assert.equal(rodarGate(c).status, 0);
});

test('chave relativa não casa (só caminho absoluto do projeto)', opts, (t) => {
  const c = cenario(); limpar(t, c);
  gravarRevisados(c.home, { '.': [c.hash] });
  assert.equal(rodarGate(c).status, 1);
});

test('JSON inválido: nenhuma supressão e aviso curto', opts, (t) => {
  const c = cenario(); limpar(t, c);
  gravarRevisados(c.home, '{ruim');
  const r = rodarGate(c);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /achados revisados: .*inválido/);
});

test('entradas que não são sha256 são ignoradas', opts, (t) => {
  const c = cenario(); limpar(t, c);
  gravarRevisados(c.home, { [fs.realpathSync(c.root)]: ['xyz', 123, c.hash.toUpperCase()] });
  assert.equal(rodarGate(c).status, 1);
});

test('o código do gate não embute hashes de achados revisados', () => {
  const txt = fs.readFileSync(gate, 'utf8');
  assert.doesNotMatch(txt, /new Set\(\[\s*'[0-9a-f]{64}'/);
});
