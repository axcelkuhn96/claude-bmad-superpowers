import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ensureWindowsPrivateDirectory, readWindowsPrivateFile,
  writeWindowsPrivateFile } from './windows-security.mjs';

const blocked = reason => ({ kind: 'blocked', reason });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const profileHash = profile => createHash('sha256').update(profile).digest('hex');
const ownerFile = (resolution, cli, profile) => path.join(resolution.stateDir,
  `owner-${cli}-${profileHash(profile)}.json`);
const binding = resolution => digest([resolution.projectId, resolution.destination,
  resolution.embeddingFingerprint]);
const ownerValid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value);
const deviceValid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const consentDigest = consent => digest([consent.version, consent.enabled, consent.projectId,
  consent.destinationHash, consent.ownerId, consent.deviceId, consent.ownerCli,
  consent.enabledAt, consent.nonce, ...(consent.ownerProfileHash ? [consent.ownerProfileHash] : [])]);

async function readPrivate(file) {
  if (process.platform === 'win32') {
    const result = await readWindowsPrivateFile(file);
    if (result.code === 'missing') return null;
    if (!result.ok) throw new Error('unsafe_policy');
    return JSON.parse(result.text);
  }
  try {
    const dir = await fs.lstat(path.dirname(file));
    const stat = await fs.lstat(file);
    if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o077) ||
        !stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('unsafe_policy');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writePrivate(file, data, replace = false) {
  const dir = path.dirname(file);
  if (process.platform === 'win32') {
    if (!(await ensureWindowsPrivateDirectory(dir)).ok) throw new Error('unsafe_policy');
    // A policy change is an explicit new declaration. Existing sessions retain their frozen record.
    const previous = await readWindowsPrivateFile(file);
    if (previous.ok && !replace) throw new Error('policy_exists');
    if (!(await writeWindowsPrivateFile(file, JSON.stringify(data) + '\n',
      { replace: previous.ok, expectedText: previous.ok ? previous.text : null })).ok) throw new Error('unsafe_policy');
    return;
  }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('unsafe_policy');
  const previous = await readPrivate(file);
  if (previous && !replace) throw new Error('policy_exists');
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(data) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try { await fs.rename(temp, file); }
  catch (error) { await fs.rm(temp, { force: true }); throw error; }
  const directory = await fs.open(dir, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function registerOwner(resolution, cli, profilePath, ownerId, attested) {
  if (!['claude', 'codex'].includes(cli) || !ownerValid(ownerId) || attested !== true ||
      typeof profilePath !== 'string' || !path.isAbsolute(profilePath)) return blocked('owner_declaration_required');
  let profile;
  try {
    profile = await fs.realpath(profilePath);
    const stat = await fs.stat(profile);
    if (!stat.isDirectory() || process.platform !== 'win32' && (!process.getuid ||
        stat.uid !== process.getuid() || (stat.mode & 0o022))) throw new Error('profile');
  } catch { return blocked('owner_profile_untrusted'); }
  const file = ownerFile(resolution, cli, profile);
  try {
    await writePrivate(file, { projectId: resolution.projectId, binding: binding(resolution),
      cli, profile, ownerId,
      declaration: 'new native human messages under this profile belong to this declared owner',
      declaredAt: new Date().toISOString() }, true);
    return { kind: 'registered', ownerId };
  } catch { return blocked('unsafe_owner_state'); }
}

export async function readOwner(resolution, cli, profilePath) {
  if (!['claude', 'codex'].includes(cli) || typeof profilePath !== 'string' ||
      !path.isAbsolute(profilePath)) return null;
  try {
    const profile = await fs.realpath(profilePath);
    const profileStat = await fs.stat(profile);
    if (!profileStat.isDirectory() || process.platform !== 'win32' && (!process.getuid ||
        profileStat.uid !== process.getuid() || (profileStat.mode & 0o022))) throw new Error('profile');
    const value = await readPrivate(ownerFile(resolution, cli, profile)) ??
      await readPrivate(path.join(resolution.stateDir, `owner-${cli}.json`));
    if (!value) return null;
    if (value.projectId !== resolution.projectId || value.binding !== binding(resolution) ||
        value.cli !== cli ||
        !ownerValid(value.ownerId) || typeof value.declaration !== 'string') throw new Error('owner_binding_changed');
    if (value.profile !== profile) return null;
    return { ownerId: value.ownerId, declaration: value.declaration,
      declaredAt: value.declaredAt };
  } catch { return blocked('owner_binding_changed'); }
}

export async function configureExtractor(resolution, selection) {
  if (!selection || !['sonnet', 'haiku', 'sol'].includes(selection.route) ||
      ['sonnet', 'haiku'].includes(selection.route) && (typeof selection.profile !== 'string' ||
      !path.isAbsolute(selection.profile) || typeof selection.executable !== 'string' ||
      !path.isAbsolute(selection.executable))) return blocked('extractor_selection_invalid');
  if (selection.route === 'sol') return blocked('sol_tool_isolation_unproved');
  let profile, executable;
  try {
    [profile, executable] = await Promise.all([fs.realpath(selection.profile), fs.realpath(selection.executable)]);
    const [profileStat, executableStat] = await Promise.all([fs.stat(profile), fs.stat(executable)]);
    if (!profileStat.isDirectory() || !executableStat.isFile() ||
        process.platform !== 'win32' && (!process.getuid || profileStat.uid !== process.getuid() ||
          (profileStat.mode & 0o022) || (executableStat.mode & 0o022))) throw new Error('untrusted');
  } catch { return blocked('extractor_path_untrusted'); }
  try {
    await writePrivate(path.join(resolution.stateDir, 'extractor.json'), {
      projectId: resolution.projectId, binding: binding(resolution), route: selection.route,
      profile, executable, maxCallsPerSession: 4, maxCandidatesPerCheckpoint: 5,
      autoPublish: false, selectedAt: new Date().toISOString() }, true);
  } catch { return blocked('unsafe_extractor_state'); }
  return { kind: 'selected', route: selection.route, cost: 'up to four automatic paid CLI calls per session; five candidates per checkpoint; auto publication off' };
}

export async function readExtractor(resolution) {
  try {
    const value = await readPrivate(path.join(resolution.stateDir, 'extractor.json'));
    if (!value) return null;
    if (value.projectId !== resolution.projectId || value.binding !== binding(resolution) ||
        !['sonnet', 'haiku'].includes(value.route) || value.maxCallsPerSession !== 4 ||
        value.maxCandidatesPerCheckpoint !== 5 ||
        (value.autoPublish !== false && value.autoPublish !== true) ||
        value.autoPublish === true && value.route !== 'haiku' ||
        value.autoPublish === false && value.autoPublishConsent != null) throw new Error('extractor_binding_changed');
    const [profile, executable] = await Promise.all([fs.realpath(value.profile), fs.realpath(value.executable)]);
    if (profile !== value.profile || executable !== value.executable) throw new Error('extractor_path_changed');
    return value.autoPublish === true && !await validConsent(resolution, value.autoPublishConsent)
      ? { ...value, autoPublish: false, autoPublishConsent: null } : value;
  } catch { return blocked('extractor_binding_changed'); }
}

async function validConsent(resolution, consent) {
  if (!consent || consent.version !== 1 || consent.enabled !== true ||
      consent.projectId !== resolution.projectId ||
      consent.destinationHash !== digest(resolution.destination) ||
      !ownerValid(consent.ownerId) || !deviceValid(consent.deviceId) ||
      !['claude', 'codex'].includes(consent.ownerCli) ||
      (consent.ownerProfileHash != null && !/^[a-f0-9]{64}$/.test(consent.ownerProfileHash)) ||
      typeof consent.enabledAt !== 'string' || !Number.isFinite(Date.parse(consent.enabledAt)) ||
      !/^[a-f0-9-]{36}$/.test(consent.nonce ?? '') ||
      consent.consentHash !== consentDigest(consent)) return false;
  const device = await localDevice(resolution.stateDir);
  if (device.kind !== 'device' || device.deviceId !== consent.deviceId) return false;
  try {
    const writer = await readPrivate(path.join(resolution.stateDir, 'ledger', 'writer.json'));
    if (writer?.projectId !== resolution.projectId ||
        writer.collection !== resolution.destination.collection ||
        writer.deviceId !== consent.deviceId || writer.revoked === true ||
        !Number.isSafeInteger(writer.generation) || writer.generation < 1) return false;
    const legacyOwnerFile = path.join(resolution.stateDir, `owner-${consent.ownerCli}.json`);
    const record = consent.ownerProfileHash
      ? await readPrivate(path.join(resolution.stateDir,
        `owner-${consent.ownerCli}-${consent.ownerProfileHash}.json`)) ?? await readPrivate(legacyOwnerFile)
      : await readPrivate(legacyOwnerFile);
    if (typeof record?.profile !== 'string' || !path.isAbsolute(record.profile) ||
        consent.ownerProfileHash && profileHash(record.profile) !== consent.ownerProfileHash) return false;
    const owner = await readOwner(resolution, consent.ownerCli, record.profile);
    return owner?.ownerId === consent.ownerId;
  } catch { return false; }
}

export async function readAutoPublish(resolution) {
  const extractor = await readExtractor(resolution);
  return extractor && extractor.kind !== 'blocked' && extractor.autoPublish === true
    ? extractor.autoPublishConsent : null;
}

export async function enableAutoPublish(resolution, { ownerId, cli, profile } = {}) {
  if (!ownerValid(ownerId) || !['claude', 'codex'].includes(cli)) return blocked('owner_declaration_required');
  let canonicalProfile;
  try { canonicalProfile = await fs.realpath(profile); }
  catch { return blocked('owner_declaration_required'); }
  const owner = await readOwner(resolution, cli, canonicalProfile);
  if (!owner || owner.kind === 'blocked' || owner.ownerId !== ownerId) return blocked('owner_declaration_required');
  const extractor = await readExtractor(resolution);
  if (!extractor || extractor.kind === 'blocked' || extractor.route !== 'haiku') return blocked('haiku_selection_required');
  const device = await localDevice(resolution.stateDir);
  if (device.kind !== 'device') return device;
  let writer;
  try { writer = await readPrivate(path.join(resolution.stateDir, 'ledger', 'writer.json')); }
  catch { return blocked('writer_not_designated'); }
  if (writer?.projectId !== resolution.projectId ||
      writer.collection !== resolution.destination.collection ||
      writer.deviceId !== device.deviceId || writer.revoked === true ||
      !Number.isSafeInteger(writer.generation) || writer.generation < 1) return blocked('writer_not_designated');
  const consent = { version: 1, enabled: true, projectId: resolution.projectId,
    destinationHash: digest(resolution.destination), ownerId, deviceId: device.deviceId,
    ownerCli: cli, ownerProfileHash: profileHash(canonicalProfile),
    enabledAt: new Date().toISOString(), nonce: randomUUID() };
  consent.consentHash = consentDigest(consent);
  try {
    await writePrivate(path.join(resolution.stateDir, 'extractor.json'), {
      ...extractor, autoPublish: true, autoPublishConsent: consent }, true);
    return { kind: 'enabled', consentHash: consent.consentHash };
  } catch { return blocked('unsafe_extractor_state'); }
}

export async function disableAutoPublish(resolution) {
  try {
    const extractor = await readPrivate(path.join(resolution.stateDir, 'extractor.json'));
    if (extractor?.projectId !== resolution.projectId ||
        extractor.binding !== binding(resolution) ||
        !['sonnet', 'haiku'].includes(extractor.route)) return blocked('extractor_binding_changed');
    const { autoPublishConsent, ...rest } = extractor;
    await writePrivate(path.join(resolution.stateDir, 'extractor.json'),
      { ...rest, autoPublish: false }, true);
    return { kind: 'disabled' };
  } catch { return blocked('unsafe_extractor_state'); }
}

export async function localDevice(stateDir) {
  const file = path.join(path.dirname(stateDir), 'device.json');
  try {
    let value = await readPrivate(file);
    if (!value) {
      await writePrivate(file, { deviceId: randomUUID() });
      value = await readPrivate(file);
    }
    if (!/^[a-f0-9-]{36}$/.test(value?.deviceId ?? '')) throw new Error('unsafe_device_state');
    return { kind: 'device', deviceId: value.deviceId };
  } catch (error) {
    if (error.code === 'EEXIST') return localDevice(stateDir);
    return blocked('unsafe_device_state');
  }
}
