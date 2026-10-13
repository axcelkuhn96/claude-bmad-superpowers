import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectConfiguration } from './provider.mjs';
import { readLocalTrust, trustTuple } from './trust.mjs';
import { readQdrantSecret } from './qdrant-key.mjs';
import { registerOwner, configureExtractor, localDevice, readOwner, readExtractor } from './policy.mjs';
import { administrativeSession, bootstrapWriter, beginWriterTransfer,
  completeWriterTransfer } from './authority.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const help = `Uso: cbs memoria <ação> [opções]
Ações: status, check, provision, activate, launch, review-correct, deactivate,
       owner-register, extractor-select, writer-device, writer-bootstrap,
       writer-transfer-start, writer-transfer-complete, help
Use --project /caminho/git nas ações de projeto. O cadastro pessoal e a seleção
do extrator exigem declaração local explícita; a publicação automática permanece off.
Activate aceita --allow-tracked-native para configuração nativa versionada autorizada.
`;
const value = (args, flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
const readSecret = readQdrantSecret;

async function askConfirmation(message, expected) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const io = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await io.question(message)).trim() === expected; }
  finally { io.close(); }
}

async function subprocess(script, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(here, script), ...args],
      { stdio: 'inherit', env: process.env });
    child.once('error', () => resolve(1));
    child.once('exit', code => resolve(code ?? 1));
  });
}

export async function main(args = []) {
  const [action, ...rest] = args;
  if (!action || action === 'help' || action === '--help') { process.stdout.write(help); return 0; }
  if (action === 'hook') {
    const [operation, encoded] = rest;
    if ((operation === 'start' && rest.length === 1) ||
        (operation === 'search' && rest.length === 2 && /^[A-Za-z0-9_-]{2,5462}$/.test(encoded))) {
      process.stdout.write('typed_trigger_only\n');
      return 0;
    }
    return 2;
  }
  const project = value(rest, '--project');
  if (!project || project.startsWith('--')) { process.stderr.write(help); return 2; }
  if (['provision', 'activate', 'launch', 'review-correct', 'deactivate'].includes(action)) {
    if (['activate', 'launch'].includes(action) && /[/\\]_npx[/\\]/.test(here)) {
      process.stderr.write('blocked: durable_package_install_required\n'); return 1;
    }
    if (action === 'launch' && process.platform !== 'win32') {
      process.stdout.write('blocked: local_native_gate_failed\n'); return 1;
    }
    if (action === 'provision') return subprocess('provision.mjs', rest);
    if (action === 'activate') return subprocess('activate.mjs', rest);
    if (action === 'deactivate') return subprocess('deactivate.mjs', rest);
    if (action === 'launch') {
      const cli = value(rest, '--cli');
      if (!['claude', 'codex'].includes(cli)) return 2;
      const extra = rest.indexOf('--');
      return subprocess('launch.mjs', [cli, project, ...(extra >= 0 ? rest.slice(extra + 1) : [])]);
    }
    const cli = value(rest, '--cli');
    const session = value(rest, '--session');
    const checkpoint = value(rest, '--checkpoint');
    const candidate = value(rest, '--candidate');
    if (!['claude', 'codex'].includes(cli) || !session || !checkpoint || !candidate) return 2;
    return subprocess('review.mjs', [cli, project, session, checkpoint, candidate]);
  }
  const resolution = await inspectConfiguration(project);
  if (resolution.provider !== 'mem0') {
    process.stdout.write(`blocked: ${resolution.reason ?? 'not_mem0'}\n`); return 1;
  }
  if (action === 'status' || action === 'check') {
    const trust = await readLocalTrust(resolution.stateDir);
    const trusted = !!trust && Object.entries(trustTuple(resolution)).every(([key, v]) => trust[key] === v);
    const owner = await readOwner(resolution, value(rest, '--cli'),
      value(rest, '--profile'));
    const extractor = await readExtractor(resolution);
    process.stdout.write(JSON.stringify({ projectId: resolution.projectId,
      collection: resolution.destination.collection, trusted,
      owner: owner?.ownerId ?? null, extractor: extractor?.route ?? null,
      autoPublish: false, release: process.platform === 'linux' ? 'linux_experimental' : 'blocked' }) + '\n');
    return 0;
  }
  if (action === 'writer-device') {
    const device = await localDevice(resolution.stateDir);
    process.stdout.write(`${device.kind}: ${device.deviceId ?? device.reason}\n`);
    return device.kind === 'device' ? 0 : 1;
  }
  if (action === 'owner-register') {
    const ownerId = value(rest, '--owner');
    const cli = value(rest, '--cli');
    const profile = value(rest, '--profile');
    if (!ownerId || !await askConfirmation(
      `Declare que mensagens humanas nativas das novas sessões deste perfil pertencem a ${ownerId}. Digite ${resolution.projectId}: `,
      resolution.projectId)) return 1;
    const result = await registerOwner(resolution, cli, profile, ownerId, true);
    process.stdout.write(`${result.kind}: ${result.reason ?? result.ownerId}\n`);
    return result.kind === 'registered' ? 0 : 1;
  }
  if (action === 'extractor-select') {
    const route = value(rest, '--route');
    if (route === 'sol') { process.stdout.write('blocked: sol_tool_isolation_unproved\n'); return 1; }
    if (!['sonnet', 'haiku'].includes(route) || !await askConfirmation(
      `${route} cobra até quatro chamadas automáticas por sessão, cinco candidatos/checkpoint; publicação automática off. Digite ${resolution.projectId}: `,
      resolution.projectId)) return 1;
    const result = await configureExtractor(resolution, { route,
      profile: value(rest, '--profile'), executable: value(rest, '--executable') });
    process.stdout.write(`${result.kind}: ${result.reason ?? result.cost}\n`);
    return result.kind === 'selected' ? 0 : 1;
  }
  if (['writer-bootstrap', 'writer-transfer-start', 'writer-transfer-complete'].includes(action)) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return 1;
    const admin = await administrativeSession(project);
    if (admin.kind !== 'session') { process.stdout.write(`${admin.kind}: ${admin.reason}\n`); return 1; }
    const device = await localDevice(resolution.stateDir);
    if (device.kind !== 'device') return 1;
    process.stdout.write(`Projeto ${resolution.projectId}; Qdrant ${resolution.destination.url}; coleção ${resolution.destination.collection}; dispositivo ${device.deviceId}\n`);
    if (!await askConfirmation(`Administrador único, clientes quiescentes: digite ${resolution.projectId}: `,
      resolution.projectId)) return 1;
    let result;
    if (action === 'writer-bootstrap') result = await bootstrapWriter(project, admin.sessionId, readSecret,
      { confirm: true, clientsQuiescent: true, singleAdministrator: true });
    else if (action === 'writer-transfer-start') {
      result = await beginWriterTransfer(project, admin.sessionId, value(rest, '--to-device'), readSecret,
        { confirm: true });
      if (result.kind === 'handoff') {
        process.stdout.write(`handoff: ${result.bundleFile}; sha256 ${result.handoffDigest}\n`);
        return 0;
      }
    } else {
      const file = value(rest, '--bundle');
      if (!file || !path.isAbsolute(file)) return 2;
      const bundle = JSON.parse(await fs.readFile(file, 'utf8'));
      result = await completeWriterTransfer(project, admin.sessionId, bundle, readSecret,
        { confirm: true });
    }
    process.stdout.write(`${result.kind}: ${result.reason ?? result.generation ?? result.deviceId}\n`);
    return ['designated', 'transferred'].includes(result.kind) ? 0 : 1;
  }
  process.stderr.write(help);
  return 2;
}
