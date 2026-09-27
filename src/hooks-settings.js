// Merge/remoção idempotente dos hooks CBS em ~/.claude/settings.json.
// Entradas CBS são reconhecidas pelo comando (…/.claude/hooks/cbs-*.js); hooks e chaves alheias nunca são tocados.
import fs from 'node:fs/promises';
import path from 'node:path';

export const HOOKS_CBS = Object.freeze([
  { evento: 'PreToolUse', matcher: 'Bash', script: 'cbs-no-verify.js', timeout: 10 },
  { evento: 'PreToolUse', matcher: 'Edit|Write|MultiEdit', script: 'cbs-config-protect.js', timeout: 10 },
  { evento: 'PostToolUse', matcher: 'Edit|Write|MultiEdit', script: 'cbs-format.js', timeout: 30 },
  { evento: 'Stop', matcher: null, script: 'cbs-typecheck.js', timeout: 90 },
].map((h) => Object.freeze(h)));
const RE_CBS = /[\\/]\.claude[\\/]hooks[\\/](cbs-[a-z-]+\.js)/;

export function scriptCbs(comando) {
  const m = typeof comando === 'string' ? comando.match(RE_CBS) : null;
  return m ? m[1] : null;
}
// Seguro dentro de aspas duplas no sh: sem $, crase, aspas nem quebra de linha (não há expansão possível).
function exigirCaminhoSeguro(p) {
  if (/[$`"\r\n]/.test(p)) throw new Error(`caminho inseguro para os hooks CBS (contém $, crase, aspas ou quebra de linha): ${JSON.stringify(p)}`);
  return p;
}
function exigirNodeSeguro(node) {
  if (!path.isAbsolute(node)) throw new Error(`caminho do node precisa ser absoluto: ${JSON.stringify(node)}`);
  exigirCaminhoSeguro(node);
}
// Hook roda via launcher POSIX (base/hooks/cbs-node.sh), que acha um node válido mesmo após troca de versão (H3).
// Launcher ou script ausente (desinstalação parcial, hook ainda não instalado) → exit 0:
// `sh arquivo-inexistente` sai 2 e node com script inexistente sai 1 — bloqueariam/sujariam toda tool call.
export function comandoHook(dirHooks, script) {
  exigirCaminhoSeguro(dirHooks);
  const launcher = path.join(dirHooks, 'cbs-node.sh');
  const js = path.join(dirHooks, script);
  const comando = `[ ! -f "${launcher}" ] || [ ! -f "${js}" ] || sh "${launcher}" "${js}"`;
  if (scriptCbs(comando) !== script) throw new Error(`comando do hook não reconhecido como ${script}: ${comando}`);
  return comando;
}
// O launcher tenta primeiro este caminho; o instalador/atualizar regrava a cada execução.
export async function gravarCaminhoNode(dirHooks, node = process.execPath) {
  exigirNodeSeguro(node);
  await fs.mkdir(dirHooks, { recursive: true });
  const arq = path.join(dirHooks, '.cbs-node-path');
  await fs.writeFile(arq, `${node}\n`, 'utf8');
  return arq;
}
const clonar = (o) => JSON.parse(JSON.stringify(o ?? {}));

export function listarHooksCbs(settings) {
  const out = [];
  for (const [evento, grupos] of Object.entries(settings?.hooks || {})) {
    if (!Array.isArray(grupos)) continue;
    for (const g of grupos) {
      for (const h of (Array.isArray(g?.hooks) ? g.hooks : [])) {
        const script = scriptCbs(h?.command);
        if (script) out.push({ evento, matcher: g.matcher ?? null, script, command: h.command, timeout: h.timeout });
      }
    }
  }
  return out;
}

export function removerHooksCbs(settings) {
  const s = clonar(settings);
  let removidos = 0;
  if (!s.hooks || typeof s.hooks !== 'object') return { settings: s, removidos };
  for (const evento of Object.keys(s.hooks)) {
    const grupos = s.hooks[evento];
    if (!Array.isArray(grupos)) continue;
    let mexeu = false;
    const novos = [];
    for (const g of grupos) {
      if (!g || !Array.isArray(g.hooks)) { novos.push(g); continue; }
      const resto = g.hooks.filter((h) => !scriptCbs(h?.command));
      if (resto.length === g.hooks.length) { novos.push(g); continue; }
      removidos += g.hooks.length - resto.length;
      mexeu = true;
      if (resto.length) novos.push({ ...g, hooks: resto });
    }
    if (mexeu) { if (novos.length) s.hooks[evento] = novos; else delete s.hooks[evento]; }
  }
  if (removidos && Object.keys(s.hooks).length === 0) delete s.hooks;
  return { settings: s, removidos };
}

function jaEstaCerto(settings, dirHooks) {
  const atuais = listarHooksCbs(settings);
  return atuais.length === HOOKS_CBS.length && HOOKS_CBS.every((h) => atuais.some((a) =>
    a.script === h.script && a.evento === h.evento && a.matcher === h.matcher
    && a.command === comandoHook(dirHooks, h.script) && a.timeout === h.timeout));
}

export function mesclarHooksCbs(settings, dirHooks) {
  if (jaEstaCerto(settings, dirHooks)) return { settings: clonar(settings), mudou: false };
  const s = removerHooksCbs(settings).settings;
  if (!s.hooks || typeof s.hooks !== 'object' || Array.isArray(s.hooks)) s.hooks = {};
  for (const h of HOOKS_CBS) {
    if (!Array.isArray(s.hooks[h.evento])) s.hooks[h.evento] = [];
    s.hooks[h.evento].push({ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: 'command', command: comandoHook(dirHooks, h.script), timeout: h.timeout }] });
  }
  return { settings: s, mudou: JSON.stringify(s) !== JSON.stringify(settings ?? {}) };
}

const ehObjeto = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

const DICA_SEM_HOOKS = 'corrija o JSON ou rode com --sem-hooks';

// `dica` é o que o usuário deve fazer; o `remover` não tem --sem-hooks, então o padrão só manda corrigir.
// `dica` null = quem lê não grava nada (status): a mensagem não fala em gravação.
export async function lerSettings(arquivo, dica = 'corrija o JSON') {
  let texto;
  try { texto = await fs.readFile(arquivo, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { existe: false, dados: {} };
    throw e;
  }
  if (!texto.trim()) return { existe: true, dados: {} };
  const acao = dica === null ? 'Corrija o JSON.' : `Nada foi gravado — ${dica}.`;
  const invalido = (motivo) => new Error(`settings.json inválido em ${arquivo}: ${motivo}. ${acao}`);
  let dados;
  try { dados = JSON.parse(texto); } catch (e) { throw invalido(e.message); }
  if (!ehObjeto(dados)) throw invalido('o topo precisa ser um objeto JSON');
  if (dados.hooks !== undefined && (!ehObjeto(dados.hooks) || !Object.values(dados.hooks).every(Array.isArray))) {
    throw invalido('"hooks" precisa ser um objeto com uma lista por evento');
  }
  return { existe: true, dados };
}

// Grava via temporário + rename no caminho REAL (symlink preservado), com o modo original e backup.
async function gravar(arquivo, dados, existia) {
  const alvo = existia ? await fs.realpath(arquivo) : arquivo;
  let backup = null;
  let modo = 0o600;
  if (existia) {
    modo = (await fs.stat(alvo)).mode & 0o777;
    backup = `${arquivo}.cbs-backup`;
    await fs.copyFile(alvo, backup);
  }
  await fs.mkdir(path.dirname(alvo), { recursive: true });
  const tmp = `${alvo}.cbs-tmp-${process.pid}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(dados, null, 2) + '\n', { encoding: 'utf8', mode: modo, flag: 'wx' });
    await fs.chmod(tmp, modo);
    await fs.rename(tmp, alvo);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
  return backup;
}

export async function aplicarHooks(arquivo, dirHooks) {
  const { existe, dados } = await lerSettings(arquivo, DICA_SEM_HOOKS);
  const { settings, mudou } = mesclarHooksCbs(dados, dirHooks);
  if (!mudou) return { mudou: false, backup: null };
  return { mudou: true, backup: await gravar(arquivo, settings, existe) };
}

// Tudo que faria o registro dos hooks falhar, checado ANTES de o instalar/atualizar copiar qualquer coisa (SP-6):
// settings.json válido, ~/.claude/hooks e o node do instalador sem caractere inseguro.
export async function prevalidarHooks(arquivo, dirHooks, node = process.execPath) {
  await lerSettings(arquivo, DICA_SEM_HOOKS);
  try {
    comandoHook(dirHooks, HOOKS_CBS[0].script);
    exigirNodeSeguro(node);
  } catch (e) {
    throw new Error(`${e.message}. Nada foi copiado — rode com --sem-hooks (instala sem registrar os hooks CBS).`);
  }
}

export async function retirarHooks(arquivo) {
  const { existe, dados } = await lerSettings(arquivo);
  if (!existe) return { removidos: 0, backup: null };
  const { settings, removidos } = removerHooksCbs(dados);
  if (!removidos) return { removidos: 0, backup: null };
  return { removidos, backup: await gravar(arquivo, settings, true) };
}
