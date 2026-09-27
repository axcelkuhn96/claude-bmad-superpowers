import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gate = path.join(RAIZ, 'base', 'scripts', 'gate-seguranca.js');
// Montado em tempo de execução: o literal casaria a regra sintética na varredura de histórico do próprio pacote.
const syntheticSecret = ['SYNTHETIC', 'GATE', 'TOKEN', 'VALUE'].join('_');
const TEM_GITLEAKS = spawnSync('gitleaks', ['version'], { encoding: 'utf8' }).status === 0;
const POSIX = process.platform !== 'win32';
const precisaGitleaks = { skip: (!TEM_GITLEAKS && 'gitleaks ausente no PATH') || (!POSIX && 'fixtures POSIX') };
const soPosix = { skip: !POSIX && 'shim POSIX' };
// Config de projeto SINTÉTICA — substitui a config de um projeto real (nada de caminho absoluto no pacote público).
const CONFIG_PROJETO_SINTETICA = `title = "Projeto sintético"

[extend]
useDefault = true

[allowlist]
description = "Exemplos documentados"
paths = ['''^docs/exemplos/''']
`;

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: 'utf8' });
}

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-gitleaks-'));
  assert.equal(run('git', ['init', '--initial-branch=main'], root).status, 0);
  assert.equal(run('git', ['config', 'user.email', 'gate@example.test'], root).status, 0);
  assert.equal(run('git', ['config', 'user.name', 'Gate test'], root).status, 0);
  write(root, '.gitleaks.toml', `title = "Gate test"

[extend]
useDefault = true

[[rules]]
id = "synthetic-gate-test"
description = "Synthetic test detector"
regex = '''SYNTHETIC_GATE_[A-Z_]+'''
secretGroup = 0
`);
  commit(root, 'trusted gitleaks policy');
  return root;
}

function write(root, filename, content) {
  const target = path.join(root, filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function execute(root, extraArgs = [], env = {}) {
  const output = path.join(root, 'reports');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-home-'));
  // Ambiente do usuário sem CBS_*: o gate não pode depender de flags da sessão de quem roda a suíte.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CBS_')));
  try {
    const result = spawnSync(process.execPath, [gate, root, '--saida', output, ...extraArgs], {
      cwd: root, encoding: 'utf8', env: { ...base, HOME: home, USERPROFILE: home, ...env },
    });
    return { output, result };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function commit(root, message) {
  assert.equal(run('git', ['add', '-A'], root).status, 0);
  assert.equal(run('git', ['commit', '-m', message], root).status, 0);
}

function allowFixture(root) {
  fs.appendFileSync(path.join(root, '.gitleaks.toml'), `
[[allowlists]]
description = "Synthetic fixture only"
targetRules = ["synthetic-gate-test"]
condition = "AND"
paths = ['^fixtures/allowed\\.txt$']
regexTarget = "line"
regexes = ['FIXTURE_GITLEAKS_MARKER']
`);
  commit(root, 'trusted fixture allowlist');
}

function useProjectConfig(root) {
  fs.writeFileSync(path.join(root, '.gitleaks.toml'), `${CONFIG_PROJETO_SINTETICA}
[[rules]]
id = "synthetic-gate-test"
description = "Synthetic test detector"
regex = '''SYNTHETIC_GATE_[A-Z_]+'''
secretGroup = 0
`, 'utf8');
  commit(root, 'trusted project configuration');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

test('ignores a synthetic secret in an untracked ignored file', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, '.gitignore', 'local.env\nreports/\n');
  write(root, 'local.env', `TOKEN=${syntheticSecret}\n`);

  const { output, result } = execute(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /✓ gitleaks: 0 segredos/);
  assert.ok(fs.existsSync(path.join(output, 'gitleaks-snapshot.json')));
});

test('rejects a synthetic secret in an untracked non-ignored file', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'candidate.txt', `TOKEN=${syntheticSecret}\n`);

  const { result } = execute(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /✗ gitleaks: 1 segredo/);
});

test('rejects an ignored path once it is forced into Git', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, '.gitignore', 'local.env\nreports/\n');
  write(root, 'local.env', `TOKEN=${syntheticSecret}\n`);
  assert.equal(run('git', ['add', '-f', 'local.env'], root).status, 0);

  const { result } = execute(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /✗ gitleaks: 1 segredo/);
});

test('rejects a dirty change to a tracked file', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'tracked.txt', 'safe\n');
  commit(root, 'baseline');
  write(root, 'tracked.txt', `TOKEN=${syntheticSecret}\n`);

  const { result } = execute(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /✗ gitleaks: 1 segredo/);
});

test('rejects a secret staged while the working copy is restored', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'tracked.txt', 'safe\n');
  commit(root, 'baseline');
  write(root, 'tracked.txt', `TOKEN=${syntheticSecret}\n`);
  assert.equal(run('git', ['add', 'tracked.txt'], root).status, 0);
  write(root, 'tracked.txt', 'safe\n');

  const { result } = execute(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /✗ gitleaks: 1 segredo/);
});

test('rejects a staged policy that tries to allow the staged secret', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'tracked.txt', 'safe\n');
  commit(root, 'baseline');
  write(root, 'tracked.txt', `TOKEN=${syntheticSecret}\n`);
  fs.appendFileSync(path.join(root, '.gitleaks.toml'), `
[[allowlists]]
description = "Candidate policy must not mask staged content"
targetRules = ["synthetic-gate-test"]
regexTarget = "line"
regexes = ['SYNTHETIC_GATE_[A-Z_]+']
`);
  assert.equal(run('git', ['add', 'tracked.txt', '.gitleaks.toml'], root).status, 0);

  const { result } = execute(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /✗ gitleaks: 1 segredo/);
});

test('fails closed when a tracked Gitleaks policy is removed from the index', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(run('git', ['rm', '--cached', '.gitleaks.toml'], root).status, 0);

  const { result } = execute(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /✓ gitleaks: 0 segredos/);
});

test('allows an unstaged deletion of a tracked directory without weakening path validation', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'nested/tracked.txt', 'safe\n');
  commit(root, 'baseline nested file');
  fs.rmSync(path.join(root, 'nested'), { recursive: true, force: true });

  const { result } = execute(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /✓ gitleaks: 0 segredos/);
});

test('rejects a secret removed after a commit through the commit scan', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'history.txt', 'safe\n');
  commit(root, 'baseline');
  const base = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  write(root, 'history.txt', `TOKEN=${syntheticSecret}\n`);
  commit(root, 'introduce synthetic secret');
  write(root, 'history.txt', 'safe again\n');
  commit(root, 'remove synthetic secret');

  const { result } = execute(root, ['--base', base]);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /✗ gitleaks: 1 segredo/);
  assert.ok(fs.existsSync(path.join(root, 'reports', 'gitleaks-commits.json')));
});

test('rejects an invalid explicit base instead of skipping the commit scan', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'safe.txt', 'safe\n');
  commit(root, 'baseline');

  const { result } = execute(root, ['--base', 'not-a-valid-ref']);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /✓ gitleaks: 0 segredos/);
});

test('allows only the marked fixture for its target rule and exact path', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  allowFixture(root);
  write(root, 'fixtures/allowed.txt', `FIXTURE_GITLEAKS_MARKER ${syntheticSecret}\n`);

  const { result } = execute(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /✓ gitleaks: 0 segredos/);
});

test('loads the project Gitleaks configuration without allowing an unrelated test rule', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  useProjectConfig(root);
  write(root, 'candidate.txt', `TOKEN=${syntheticSecret}\n`);

  const { result } = execute(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
});

test('rejects an allowlist marker in another path', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  allowFixture(root);
  write(root, 'fixtures/other.txt', `FIXTURE_GITLEAKS_MARKER ${syntheticSecret}\n`);

  const { result } = execute(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
});

test('rejects an unmarked secret in an allowlisted fixture path', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  allowFixture(root);
  write(root, 'fixtures/allowed.txt', `unmarked ${syntheticSecret}\n`);

  const { result } = execute(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
});

test('rejects a new unmarked fixture line alongside an allowed line', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  allowFixture(root);
  write(root, 'fixtures/allowed.txt', `FIXTURE_GITLEAKS_MARKER ${syntheticSecret}\nextra ${syntheticSecret}\n`);

  const { result } = execute(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
});

test('scans an unstaged policy as data without using it as authority', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.appendFileSync(path.join(root, '.gitleaks.toml'), `
# ${syntheticSecret}
[[allowlists]]
description = "Candidate policy must not authorize itself"
targetRules = ["synthetic-gate-test"]
regexTarget = "line"
regexes = ['SYNTHETIC_GATE_[A-Z_]+']
`);

  const { result } = execute(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /✗ gitleaks: 1 segredo/);
});

test('rejects an unexpected gitleaks exit code', soPosix, (t) => {
  const root = repository();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-gitleaks-bin-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });
  const executable = path.join(bin, 'gitleaks');
  fs.writeFileSync(executable, '#!/bin/sh\necho operational failure >&2\nexit 2\n', { mode: 0o755 });

  const { result } = execute(root, [], { PATH: `${bin}${path.delimiter}${process.env.PATH}` });

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /✓ gitleaks: 0 segredos/);
});

test('rejects a gitleaks finding exit without its report', soPosix, (t) => {
  const root = repository();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-gitleaks-bin-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });
  const executable = path.join(bin, 'gitleaks');
  fs.writeFileSync(executable, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

  const { result } = execute(root, [], { PATH: `${bin}${path.delimiter}${process.env.PATH}` });

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /✓ gitleaks: 0 segredos/);
});

test('rejects a successful scan that leaves only a stale snapshot report', soPosix, (t) => {
  const root = repository();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-gitleaks-bin-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });
  const reports = path.join(root, 'reports');
  fs.mkdirSync(reports, { recursive: true });
  fs.writeFileSync(path.join(reports, 'gitleaks-snapshot.json'), '[{"File":"stale.txt","RuleID":"synthetic-gate-test","StartLine":1}]\n');
  fs.writeFileSync(path.join(bin, 'gitleaks'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const { result } = execute(root, [], { PATH: `${bin}${path.delimiter}${process.env.PATH}` });

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /✓ gitleaks: 0 segredos/);
});

test('preserves a filename with spaces and a newline during enumeration', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'nested/name with space\nand newline.txt', `TOKEN=${syntheticSecret}\n`);

  const { result } = execute(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
});

test('materializes a tracked symlink without following its traversal target', precisaGitleaks, (t) => {
  const root = repository();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-gitleaks-outside-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  write(outside, 'outside.txt', `TOKEN=${syntheticSecret}\n`);
  fs.symlinkSync(path.join(outside, 'outside.txt'), path.join(root, 'linked.txt'));
  assert.equal(run('git', ['add', 'linked.txt'], root).status, 0);

  const { result } = execute(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /✓ gitleaks: 0 segredos/);
});

test('uses the directory scan fallback outside Git', precisaGitleaks, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-non-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, '.gitleaks.toml', `title = "Gate test"
[[rules]]
id = "synthetic-gate-test"
regex = '''SYNTHETIC_GATE_[A-Z_]+'''
secretGroup = 0
`);
  write(root, 'candidate.txt', `TOKEN=${syntheticSecret}\n`);

  const { output, result } = execute(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(fs.existsSync(path.join(output, 'gitleaks-dir.json')));
});

test('pins both Git defenses on the directory scan fallback outside Git', soPosix, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-non-git-env-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-gitleaks-env-bin-'));
  const log = path.join(root, 'gitleaks-env.log');
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(bin, 'gitleaks'), `#!/bin/sh
printf '%s %s\\n' "$GIT_NO_REPLACE_OBJECTS" "$GIT_NO_LAZY_FETCH" >> "$GATE_ENV_LOG"
while [ "$#" -gt 0 ]; do
  if [ "$1" = --report-path ]; then report="$2"; shift 2; continue; fi
  shift
done
printf '[]\\n' > "$report"
`, { mode: 0o755 });

  const { result } = execute(root, [], {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GATE_ENV_LOG: log,
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(log, 'utf8').trim(), '1 1');
});

test('removes the temporary snapshot after success and candidate-policy findings', precisaGitleaks, (t) => {
  const root = repository();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-gitleaks-tmp-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const success = execute(root, [], { TMPDIR: tmp });
  assert.equal(success.result.status, 0, success.result.stdout + success.result.stderr);
  assert.deepEqual(fs.readdirSync(tmp).filter((entry) => entry.startsWith('gitleaks-snapshot-')), []);

  fs.appendFileSync(path.join(root, '.gitleaks.toml'), `\n# ${syntheticSecret}\n`);
  const failure = execute(root, [], { TMPDIR: tmp });
  assert.equal(failure.result.status, 1, failure.result.stdout + failure.result.stderr);
  assert.deepEqual(fs.readdirSync(tmp).filter((entry) => entry.startsWith('gitleaks-snapshot-')), []);
});

test('never lets an untracked policy mask a staged secret', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'tracked.txt', 'safe\n');
  commit(root, 'baseline with restrictive policy');
  write(root, 'tracked.txt', `TOKEN=${syntheticSecret}\n`);
  assert.equal(run('git', ['add', 'tracked.txt'], root).status, 0);
  fs.renameSync(path.join(root, '.gitleaks.toml'), path.join(root, '.gitleaks.toml.trusted'));
  write(root, '.gitleaks.toml', 'title = "untracked permissive policy"\n[[allowlists]]\ndescription = "must not be read"\ntargetRules = ["synthetic-gate-test"]\nregexTarget = "line"\nregexes = [\'SYNTHETIC_GATE_[A-Z_]+\']\n');

  const { result } = execute(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /✗ gitleaks: 1 segredo/);
});

test('uses the separate history policy only for commits, never for current content', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, '.gitleaks-history.toml', 'title = "history only"\n[extend]\nuseDefault = true\n[[rules]]\nid = "synthetic-gate-test"\ndescription = "Synthetic test detector"\nregex = \'\'\'SYNTHETIC_GATE_[A-Z_]+\'\'\'\nsecretGroup = 0\n[[allowlists]]\ndescription = "historical fixture"\ntargetRules = ["synthetic-gate-test"]\nregexTarget = "line"\nregexes = [\'FIXTURE_GITLEAKS_MARKER\']\n');
  write(root, 'history.txt', 'safe\n');
  commit(root, 'baseline history policy');
  const base = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  write(root, 'history.txt', `FIXTURE_GITLEAKS_MARKER ${syntheticSecret}\n`);
  commit(root, 'allowed historical fixture');
  write(root, 'current.txt', `FIXTURE_GITLEAKS_MARKER ${syntheticSecret}\n`);

  const { result } = execute(root, ['--base', base]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /✗ gitleaks: 2 segredo/);
});

test('rejects a candidate history policy that would allow a secret in its own commit range', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  write(root, '.gitleaks-history.toml', `title = "candidate history policy"
[[rules]]
id = "synthetic-gate-test"
regex = '''SYNTHETIC_GATE_[A-Z_]+'''
secretGroup = 0
[[allowlists]]
targetRules = ["synthetic-gate-test"]
regexTarget = "line"
regexes = ['SYNTHETIC_GATE_[A-Z_]+']
`);
  write(root, 'history.txt', `TOKEN=${syntheticSecret}\n`);
  commit(root, 'candidate policy and secret');

  const { result } = execute(root, ['--base', base]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /✗ gitleaks: 1 segredo/);
});

test('bootstraps a policy-only commit without trusting it for that commit', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const policy = fs.readFileSync(path.join(root, '.gitleaks.toml'), 'utf8');
  assert.equal(run('git', ['rm', '.gitleaks.toml'], root).status, 0);
  commit(root, 'baseline without policy');
  const base = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  write(root, '.gitleaks.toml', policy);
  commit(root, 'introduce policy only');
  write(root, 'history.txt', `TOKEN=${syntheticSecret}\n`);
  commit(root, 'secret after policy');

  const { result } = execute(root, ['--base', base]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /✗ gitleaks: 1 segredo/);
  assert.doesNotMatch(result.stdout, /gitleaks: erro/);
});

test('rejects a Git replacement reference before scanning history', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'safe.txt', 'safe\n');
  commit(root, 'second commit');
  const head = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const parent = run('git', ['rev-parse', 'HEAD^'], root).stdout.trim();
  assert.equal(run('git', ['replace', head, parent], root).status, 0);

  const { result } = execute(root, ['--base', parent]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /✓ gitleaks: 0 segredos/);
});

test('rejects a warning emitted by an otherwise successful Gitleaks scan', soPosix, (t) => {
  const root = repository();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-gitleaks-bin-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(bin, 'gitleaks'), `#!/bin/sh
for arg in "$@"; do
  case "$arg" in --report-path=*) report=\${arg#--report-path=};; esac
done
printf '[]\\n' > "$report"
printf 'WRN skipped candidate' >&2
exit 0
`, { mode: 0o755 });

  const { result } = execute(root, [], { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /✓ gitleaks: 0 segredos/);
});

test('does not let --saida exclude a tracked tree from the scan', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'reports/tracked.txt', `TOKEN=${syntheticSecret}\n`);
  commit(root, 'tracked output tree');

  const { result } = execute(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /✗ gitleaks: 1 segredo/);
});

test('fails closed for an invalid UTF-8 Git path instead of skipping it', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const invalid = Buffer.concat([Buffer.from('invalid-'), Buffer.from([0xff]), Buffer.from('.txt')]);
  fs.writeFileSync(Buffer.concat([Buffer.from(root), Buffer.from(path.sep), invalid]), 'safe\n');
  const add = spawnSync('git', ['add', '-A'], { cwd: root, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr);

  const { result } = execute(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /✓ gitleaks: 0 segredos/);
});

test('fails closed when the staged policy is a symbolic link', precisaGitleaks, (t) => {
  const root = repository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'policy.toml', 'title = "not a policy target"\n');
  fs.rmSync(path.join(root, '.gitleaks.toml'));
  fs.symlinkSync('policy.toml', path.join(root, '.gitleaks.toml'));
  assert.equal(run('git', ['add', '-A'], root).status, 0);

  const { result } = execute(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /✓ gitleaks: 0 segredos/);
});

test('pins both Git defenses on every Git and Gitleaks subprocess during a replacement race', precisaGitleaks, (t) => {
  const root = repository();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-gitleaks-env-bin-'));
  const log = path.join(root, 'git-env.log');
  const realGit = run('sh', ['-c', 'command -v git'], root).stdout.trim();
  const realGitleaks = run('sh', ['-c', 'command -v gitleaks'], root).stdout.trim();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });

  write(root, 'safe.txt', 'safe\n');
  commit(root, 'second commit');
  const head = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const parent = run('git', ['rev-parse', 'HEAD^'], root).stdout.trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
printf 'git %s %s %s\\n' "$GIT_NO_REPLACE_OBJECTS" "$GIT_NO_LAZY_FETCH" "$*" >> "$GATE_ENV_LOG"
if [ "$1" = replace ] && [ "$2" = -l ]; then
  ${shellQuote(realGit)} "$@"
  ${shellQuote(realGit)} replace "$GATE_ATTACK_HEAD" "$GATE_ATTACK_PARENT"
  exit 0
fi
exec ${shellQuote(realGit)} "$@"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'gitleaks'), `#!/bin/sh
printf 'gitleaks %s %s %s\\n' "$GIT_NO_REPLACE_OBJECTS" "$GIT_NO_LAZY_FETCH" "$*" >> "$GATE_ENV_LOG"
exec ${shellQuote(realGitleaks)} "$@"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'semgrep'), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then
    printf '{"results":[],"errors":[]}\\n' > "$2"
    break
  fi
  shift
done
exit 0
`, { mode: 0o755 });

  const { result } = execute(root, ['--base', parent], {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GATE_ENV_LOG: log,
    GATE_ATTACK_HEAD: head,
    GATE_ATTACK_PARENT: parent,
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(run('git', ['replace', '-l'], root).stdout.includes(head));
  const entries = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(entries.length > 0);
  for (const entry of entries) assert.match(entry, /^(?:git|gitleaks) 1 1 /, entry);
});

test('reprova quando o gitleaks não está no PATH (política 0.13.0)', soPosix, (t) => {
  const root = repository();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-sem-gitleaks-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }); });
  const gitReal = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  fs.symlinkSync(gitReal, path.join(bin, 'git'));
  const { result } = execute(root, [], { PATH: bin });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /gitleaks: não instalado/);
  assert.match(result.stdout, /GATE: REPROVADO/);
});

// Token montado em tempo de execução: o literal não aparece no fonte do pacote.
const tokenRegraDefault = `ghp_${'Zq8Lm3Vt7Rk2Xw9Pb4Ns6Hd1Fy5Jc0Ge8Ua'}`;

function repositorioSemPolitica() {
  const root = repository();
  assert.equal(run('git', ['rm', '-q', '.gitleaks.toml'], root).status, 0);
  write(root, 'safe.txt', 'safe\n');
  commit(root, 'projeto sem política gitleaks');
  return root;
}

test('sem .gitleaks.toml no HEAD usa as regras default do gitleaks e não reprova', precisaGitleaks, (t) => {
  const root = repositorioSemPolitica();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { result } = execute(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /✓ gitleaks: sem \.gitleaks\.toml no HEAD — regras default/);
  assert.match(result.stdout, /✓ gitleaks: 0 segredos/);
});

test('sem .gitleaks.toml no HEAD as regras default reprovam segredo e ignoram política candidata', precisaGitleaks, (t) => {
  const root = repositorioSemPolitica();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, '.gitleaks.toml', 'title = "candidata permissiva"\n[allowlist]\ndescription = "não pode ser lida"\npaths = [\'\'\'.*\'\'\']\n');
  write(root, 'candidate.txt', `token = "${tokenRegraDefault}"\n`);

  const { result } = execute(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /✗ gitleaks: 1 segredo/);
  assert.match(result.stdout, /GATE: REPROVADO/);
});

test('com HEAD sem commit usa as regras default do gitleaks', precisaGitleaks, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-unborn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(run('git', ['init', '--initial-branch=main'], root).status, 0);
  write(root, 'safe.txt', 'safe\n');

  const { result } = execute(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /✓ gitleaks: sem \.gitleaks\.toml no HEAD — regras default/);
});

test('falha do git ao ler a política do HEAD reprova em vez de cair nas regras default', precisaGitleaks, (t) => {
  const root = repository();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-git-falho-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(bin, { recursive: true, force: true }); });
  const gitReal = run('sh', ['-c', 'command -v git'], root).stdout.trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
if [ "$1" = ls-tree ]; then echo 'fatal: falha simulada' >&2; exit 128; fi
exec ${shellQuote(gitReal)} "$@"
`, { mode: 0o755 });

  const { result } = execute(root, [], { PATH: `${bin}${path.delimiter}${process.env.PATH}` });

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /regras default/);
  assert.doesNotMatch(result.stdout, /✓ gitleaks: 0 segredos/);
});
