// Inventário incremental de skills. Só lê SKILL.md e consulta a existência de
// referências locais; não executa instruções, instala nem modifica arquivos.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

const MAX_DEPTH = 7;
const MAX_DIRS = 2000;
const MAX_SKILLS = 1000;
const MAX_SKILL_BYTES = 256 * 1024;
const MAX_REFERENCES = 100;
const SENSITIVE_NAME = /(?:^|[\/._-])(?:secret|secrets|password|passwd|token|credential|credentials|api[-_]?key|private[-_]?key|\.env)(?:$|[\/._-])/i;

function isWithin(candidate, directory) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function frontmatterName(content) {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const name = match?.[1].match(/^name:\s*(.+?)\s*$/m)?.[1];
  return name?.replace(/^['"]|['"]$/g, '') || null;
}

function body(content) {
  return content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
}

function headings(content) {
  return [...content.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((match) => match[1].trim());
}

function referenceCandidates(content) {
  const candidates = new Set();
  // Markdown links and code-quoted paths are the explicit local references used
  // in the CBS, Superpowers and Taste skills. Never inspect arbitrary prose.
  for (const match of content.matchAll(/!?(?:\[[^\]\n]*\])\(([^\s)]+)(?:\s+['"][^)]*['"])?\)/g)) candidates.add(match[1]);
  for (const match of content.matchAll(/`([^`\n]+)`/g)) {
    if (/^(?:\.{1,2}\/)?[\w.-]+(?:\/[\w. -]+)+\.[\w-]+$/.test(match[1])) candidates.add(match[1]);
  }
  return [...candidates].slice(0, MAX_REFERENCES);
}

async function inspectReference(raw, skillDirectory) {
  if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(raw)) return null;
  let decoded;
  try { decoded = decodeURIComponent(raw.split('#')[0].split('?')[0]); } catch { decoded = raw; }
  if (!decoded || decoded.startsWith('//')) return null;
  if (SENSITIVE_NAME.test(decoded)) return { status: 'sensitive' };
  if (path.isAbsolute(decoded) || /^[a-z]:[\\/]/i.test(decoded)) return { status: 'outside_scope' };
  const resolved = path.resolve(skillDirectory, decoded);
  if (!isWithin(resolved, skillDirectory)) return { status: 'outside_scope' };
  const relative = path.relative(skillDirectory, resolved).split(path.sep).join('/');
  try {
    const real = await fs.realpath(resolved);
    if (!isWithin(real, skillDirectory)) return { status: 'outside_scope' };
    const stat = await fs.stat(real);
    return { path: relative, status: stat.isFile() || stat.isDirectory() ? 'available' : 'unsupported' };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { path: relative, status: 'missing' };
    return { path: relative, status: 'unreadable' };
  }
}

function matchingContracts(skill, reviewedSources) {
  return reviewedSources.filter((source) => source && (
    (source.path && path.resolve(source.path) === skill.canonicalPath)
    || (source.name && source.name === skill.declaredName)
  )).map((source) => {
    const actualHeadings = new Set(skill.headings.map((heading) => heading.toLowerCase()));
    const actualReferences = new Set(skill.references.map((reference) => reference.path).filter(Boolean));
    return {
      name: source.name || null,
      reviewedHashMatch: typeof source.sha256 === 'string' && /^[a-f\d]{64}$/i.test(source.sha256)
        ? source.sha256.toLowerCase() === skill.hash : null,
      missingHeadings: (source.requiredHeadings || []).filter((heading) => !actualHeadings.has(heading.toLowerCase())),
      missingReferences: (source.requiredReferences || []).filter((reference) => !actualReferences.has(reference)),
      semanticCompatibility: 'unverified',
    };
  });
}

async function skillAt(directory, root, byCanonical, limits) {
  const file = path.join(directory, 'SKILL.md');
  let canonicalPath; let stat;
  try {
    canonicalPath = await fs.realpath(file);
    if (path.basename(canonicalPath) !== 'SKILL.md') return false;
    stat = await fs.stat(canonicalPath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    limits.unreadable++;
    return false;
  }
  if (!stat.isFile()) return false;
  const canonicalDirectory = path.dirname(canonicalPath);
  if (stat.size > MAX_SKILL_BYTES || byCanonical.size >= MAX_SKILLS) {
    limits.skipped++;
    return true;
  }
  const existing = byCanonical.get(canonicalPath);
  if (existing) {
    existing.aliases.add(file);
    if (root.source) existing.sources.add(root.source);
    return true;
  }
  try {
    const bytes = await fs.readFile(canonicalPath);
    if (bytes.length > MAX_SKILL_BYTES) { limits.skipped++; return true; }
    const content = bytes.toString('utf8');
    const references = [];
    for (const raw of referenceCandidates(content)) {
      const reference = await inspectReference(raw, canonicalDirectory);
      if (reference) references.push(reference);
    }
    byCanonical.set(canonicalPath, {
      path: canonicalPath,
      canonicalPath,
      aliases: new Set([canonicalPath, file]),
      sources: new Set(root.source ? [root.source] : []),
      declaredName: frontmatterName(content),
      hash: createHash('sha256').update(bytes).digest('hex'),
      bodyHash: createHash('sha256').update(body(content)).digest('hex'),
      headings: headings(content),
      references,
      usage: 'unmeasured',
    });
  } catch {
    limits.unreadable++;
  }
  return true;
}

/**
 * Snapshot of explicit skill roots. `previous` may be a prior returned report.
 * A first scan establishes an unknown baseline; only later scans can establish
 * added, changed, unchanged or deleted content.
 */
export async function inventorySkills({ roots, previous, reviewedSources = [] } = {}) {
  if (!Array.isArray(roots)) throw new TypeError('roots must be an array of explicit paths');
  if (!Array.isArray(reviewedSources)) throw new TypeError('reviewedSources must be an array');
  const byCanonical = new Map();
  const missingRoots = [];
  const limits = { skipped: 0, unreadable: 0, directories: 0, depthLimited: 0, truncated: false, maxDepth: MAX_DEPTH, maxDirectories: MAX_DIRS, maxSkills: MAX_SKILLS, maxSkillBytes: MAX_SKILL_BYTES };
  const seenDirs = new Set();
  for (const item of roots) {
    const root = typeof item === 'string' ? { path: item } : item;
    if (!root || typeof root.path !== 'string' || !path.isAbsolute(root.path)) throw new TypeError('each root needs an absolute path');
    const rootPath = path.resolve(root.path);
    if (rootPath === path.parse(rootPath).root || rootPath === os.homedir()) throw new TypeError('root is too broad for a bounded inventory');
    let stat;
    try { stat = await fs.stat(rootPath); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') { missingRoots.push(rootPath); continue; }
      limits.unreadable++; continue;
    }
    if (stat.isFile()) {
      if (path.basename(rootPath) === 'SKILL.md') await skillAt(path.dirname(rootPath), root, byCanonical, limits);
      continue;
    }
    if (!stat.isDirectory()) continue;
    const rootCanonical = await fs.realpath(rootPath);
    const queue = [{ directory: rootPath, depth: 0 }];
    while (queue.length && limits.directories < MAX_DIRS && byCanonical.size < MAX_SKILLS) {
      const { directory, depth } = queue.shift();
      await skillAt(directory, root, byCanonical, limits);
      let canonical;
      try { canonical = await fs.realpath(directory); } catch { limits.unreadable++; continue; }
      if (seenDirs.has(canonical)) continue;
      seenDirs.add(canonical);
      limits.directories++;
      if (depth >= MAX_DEPTH) { limits.depthLimited++; continue; }
      let children;
      try { children = await fs.readdir(directory, { withFileTypes: true }); } catch { limits.unreadable++; continue; }
      for (const child of children) {
        if (child.name.startsWith('.') && child.name !== '.agents' && child.name !== '.claude' && child.name !== '.codex') continue;
        if (child.isDirectory()) queue.push({ directory: path.join(directory, child.name), depth: depth + 1 });
        else if (child.isSymbolicLink()) {
          const next = path.join(directory, child.name);
          try {
            if (!(await fs.stat(next)).isDirectory()) continue;
            const target = await fs.realpath(next);
            if (!isWithin(target, rootCanonical)) {
              const marker = await fs.stat(path.join(next, 'SKILL.md')).catch(() => null);
              if (!marker?.isFile()) continue;
            }
            queue.push({ directory: next, depth: depth + 1 });
          } catch { /* dangling alias */ }
        }
      }
    }
    if (queue.length) limits.truncated = true;
  }
  if (byCanonical.size >= MAX_SKILLS) limits.truncated = true;
  const previousSkills = new Map((Array.isArray(previous?.skills) ? previous.skills : [])
    .filter((skill) => typeof skill.canonicalPath === 'string')
    .map((skill) => [skill.canonicalPath, skill]));
  const hasPrevious = previous != null;
  const skills = [...byCanonical.values()].sort((a, b) => a.canonicalPath.localeCompare(b.canonicalPath)).map((skill) => {
    const prior = previousSkills.get(skill.canonicalPath);
    const change = !hasPrevious ? 'unknown' : !prior ? 'added' : prior.hash === skill.hash ? 'unchanged' : 'changed';
    const bodyChangedSincePrior = !hasPrevious || !prior || !prior.bodyHash ? null : prior.bodyHash !== skill.bodyHash;
    return {
      ...skill,
      aliases: [...skill.aliases].sort(),
      sources: [...skill.sources].sort(),
      change,
      changedSincePrior: change === 'unknown' ? null : change === 'changed' || change === 'added',
      bodyChangedSincePrior,
      contracts: matchingContracts(skill, reviewedSources),
    };
  });
  const deleted = hasPrevious ? [...previousSkills.values()]
    .filter((skill) => !byCanonical.has(skill.canonicalPath))
    .map(({ canonicalPath, declaredName, hash }) => ({ canonicalPath, declaredName, hash, change: 'deleted' })) : [];
  const groups = new Map();
  for (const skill of skills.filter((entry) => entry.declaredName)) {
    if (!groups.has(skill.declaredName)) groups.set(skill.declaredName, []);
    groups.get(skill.declaredName).push(skill);
  }
  const divergences = [...groups].filter(([, group]) => group.length > 1 && new Set(group.map((skill) => skill.hash)).size > 1)
    .map(([declaredName, group]) => ({ declaredName, severity: 'info', paths: group.map((skill) => skill.canonicalPath), reason: 'content_hash_differs' }));
  return {
    formatVersion: 1,
    baseline: hasPrevious ? 'compared' : 'unknown',
    skills,
    deleted,
    divergences,
    missingRoots: missingRoots.sort(),
    summary: {
      total: skills.length,
      unknown: skills.filter((skill) => skill.change === 'unknown').length,
      added: skills.filter((skill) => skill.change === 'added').length,
      changed: skills.filter((skill) => skill.change === 'changed').length,
      unchanged: skills.filter((skill) => skill.change === 'unchanged').length,
      deleted: deleted.length,
    },
    limits,
  };
}
