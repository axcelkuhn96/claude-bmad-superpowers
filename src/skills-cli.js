import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { inventorySkills } from './skill-inventory.js';

const help = `Uso: cbs skills inventario [--changed] [--json] [--root <diretório>] [--snapshot <arquivo.json>] [--save-snapshot <arquivo.json>]

Lê apenas SKILL.md nas raízes de skills Claude, Codex, .agents e do projeto atual.
--root pode ser repetido e substitui as raízes padrão. --changed compara hashes com
--snapshot ou com o último snapshot CBS, se existir. O primeiro inventário tem
baseline desconhecido; ausência de uso medido não significa uso zero.
--save-snapshot aceita somente um arquivo no diretório privado
~/.local/state/cbs/skills-inventory/; nunca altera skills instaladas.
`;

const snapshotDir = () => path.join(os.homedir(), '.local', 'state', 'cbs', 'skills-inventory');
const defaultSnapshot = () => path.join(snapshotDir(), 'snapshot.json');

function parse(args) {
  const options = { roots: [], changed: false, json: false, snapshot: null, save: null };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--changed' || flag === '--json') {
      if (seen.has(flag)) throw new Error('invalid_arguments');
      options[flag.slice(2)] = true;
    } else if (['--root', '--snapshot', '--save-snapshot'].includes(flag)) {
      if ((flag !== '--root' && seen.has(flag)) || !args[i + 1] || args[i + 1].startsWith('--')) {
        throw new Error('invalid_arguments');
      }
      const value = path.resolve(args[++i]);
      if (flag === '--root') options.roots.push(value);
      else options[flag === '--snapshot' ? 'snapshot' : 'save'] = value;
    } else throw new Error('invalid_arguments');
    seen.add(flag);
  }
  return options;
}

function defaultRoots() {
  const home = os.homedir();
  const cwd = process.cwd();
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
  return [
    { path: path.join(claudeHome, 'skills'), source: 'claude-global' },
    { path: path.join(codexHome, 'skills'), source: 'codex-global' },
    { path: path.join(home, '.agents', 'skills'), source: 'agents-global' },
    ...['.claude', '.codex', '.agents'].map(name => ({
      path: path.join(cwd, name, 'skills'), source: `project-${name.slice(1)}` })),
    { path: path.join(claudeHome, 'plugins', 'cache'), source: 'claude-plugin-cache:runtime_unverified' },
    { path: path.join(codexHome, 'plugins', 'cache'), source: 'codex-plugin-cache:runtime_unverified' },
  ];
}

async function readSnapshot(file, optional = false) {
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('invalid_snapshot');
  let prior;
  try { prior = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { throw new Error('invalid_snapshot'); }
  if (![1, 2].includes(prior?.formatVersion) || !Array.isArray(prior.skills) || prior.skills.length > 1000 ||
      prior.skills.some(skill => typeof skill.canonicalPath !== 'string' ||
        !path.isAbsolute(skill.canonicalPath) || !/^[a-f0-9]{64}$/.test(skill.hash))) {
    throw new Error('invalid_snapshot');
  }
  if (prior.formatVersion === 1) return { ...prior, scope: undefined };
  const roots = prior.scope?.roots;
  if (!Array.isArray(roots) || roots.length > 1000 || typeof prior.scope.complete !== 'boolean' ||
      roots.some(root => typeof root.path !== 'string' || !path.isAbsolute(root.path) ||
        (root.canonicalPath !== null && (typeof root.canonicalPath !== 'string' || !path.isAbsolute(root.canonicalPath))) ||
        !['directory', 'file', 'missing', 'unreadable', 'unsupported'].includes(root.kind)) ||
      createHash('sha256').update(JSON.stringify(roots)).digest('hex') !== prior.scope.fingerprint) {
    throw new Error('invalid_snapshot');
  }
  return prior;
}

function within(candidate, directory) {
  const relative = path.relative(directory, candidate);
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

async function saveSnapshot(file, report) {
  const base = snapshotDir();
  if (!within(file, base) || path.dirname(file) !== base) {
    throw new Error('snapshot_outside_cbs_state');
  }
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  const baseStat = await fs.lstat(base);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink() || (baseStat.mode & 0o077)) {
    throw new Error('snapshot_directory_not_private');
  }
  const destinationDir = base;
  const realBase = await fs.realpath(base);
  const realDestinationDir = await fs.realpath(destinationDir);
  if (realBase !== base || realDestinationDir !== base) {
    throw new Error('snapshot_outside_cbs_state');
  }
  const destinationStat = await fs.stat(destinationDir);
  if (destinationStat.mode & 0o077) throw new Error('snapshot_directory_not_private');
  const old = await fs.lstat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (old && (!old.isFile() || old.isSymbolicLink())) throw new Error('invalid_snapshot_destination');
  const temporary = path.join(destinationDir, `.snapshot-${randomUUID()}`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(report)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function skillsCli(args = []) {
  if (args.length === 1 && ['help', '--help', '-h'].includes(args[0])) {
    process.stdout.write(help); return 0;
  }
  const [action, ...rest] = args;
  if (action !== 'inventario') { process.stderr.write(help); return 2; }
  if (rest.length === 1 && ['help', '--help', '-h'].includes(rest[0])) {
    process.stdout.write(help); return 0;
  }
  let options;
  try { options = parse(rest); }
  catch (error) { process.stderr.write(`${error.message}\n${help}`); return 2; }
  try {
    const previous = options.snapshot ? await readSnapshot(options.snapshot) :
      options.changed ? await readSnapshot(defaultSnapshot(), true) : null;
    const roots = options.roots.length ? options.roots : defaultRoots();
    const report = await inventorySkills({ roots, previous });
    if (options.save) await saveSnapshot(options.save, report);
    const selected = options.changed ? {
      ...report,
      skills: report.skills.filter(skill => ['added', 'changed'].includes(skill.change)),
    } : report;
    if (options.json) process.stdout.write(`${JSON.stringify(selected)}\n`);
    else {
      process.stdout.write(`Skills: ${report.summary.total}; baseline: ${report.baseline}; ` +
        `novas: ${report.summary.added}; alteradas: ${report.summary.changed}; ` +
        `removidas: ${report.summary.deleted}; não observadas: ${report.summary.unobserved}; uso: não medido\n`);
      for (const skill of selected.skills) {
        process.stdout.write(`${skill.change}\t${skill.declaredName ?? '(sem nome)'}\t${skill.canonicalPath}\t${skill.hash}\n`);
      }
      for (const skill of selected.deleted) process.stdout.write(`deleted\t${skill.declaredName ?? '(sem nome)'}\t${skill.canonicalPath}\n`);
      for (const skill of selected.unobserved) process.stdout.write(`unobserved\t${skill.declaredName ?? '(sem nome)'}\t${skill.canonicalPath}\n`);
      for (const root of report.missingRoots) process.stdout.write(`raiz ausente\t${root}\n`);
      if (report.scopeChanged) process.stdout.write('Escopo de comparação diferente; ausências não confirmam remoções.\n');
      else if (previous && !report.scope.complete) process.stdout.write('Varredura incompleta; ausências não confirmam remoções.\n');
      if (report.limits.truncated) process.stdout.write('Inventário truncado pelos limites de leitura.\n');
    }
    return 0;
  } catch (error) {
    process.stderr.write(`CBS skills inventario: ${error.message}\n`);
    return /^(?:invalid_|snapshot_|root is too broad|each root needs)/.test(error.message) ? 2 : 1;
  }
}
