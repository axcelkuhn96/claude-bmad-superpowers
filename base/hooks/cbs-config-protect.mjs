#!/usr/bin/env node
// cbs-config-protect.mjs — PreToolUse (Edit|Write|MultiEdit; Codex: apply_patch): bloqueia enfraquecer config de lint/format.
// Escape: CBS_PERMITIR_CONFIG=1. package.json, tsconfig.json e composer.json nunca são bloqueados.
// Derivado de affaan-m/ECC @ e482e57, scripts/hooks/config-protection.js — MIT License,
// Copyright (c) 2026 Affaan Mustafa. Licença: https://github.com/affaan-m/ECC/blob/e482e57/LICENSE
import fs from 'node:fs';
import path from 'node:path';
import { hookDesligado, lerStdin, lerPayload, lerTexto, caminhosEditados, comandoBash, ehEntrada, avisar, LIMITE_STDIN } from './cbs-comum.mjs';

// Configs inteiras: qualquer edição de arquivo existente bloqueia. Nomes exatos (as ferramentas procuram em
// minúsculas); variante de caixa é resolvida no disco por nomeVisto.
export const PROTEGIDOS = [
  /^\.eslintrc/, /^eslint\.config\./, /^\.prettierrc/, /^prettier\.config\./, /^biome\.jsonc?$/,
  /^pint\.json$/, /^phpstan\.neon/, /^phpstan\.dist\.neon$/, /^phpstan-baseline\.neon$/, /^\.php-cs-fixer/, /^\.?ruff\.toml$/,
  /^\.?mypy\.ini$/, /^\.stylelintrc/, /^stylelint\.config\./,
];
const RE_CITA_PROTEGIDO = /(?:eslintrc|eslint\.config\.|prettierrc|prettier\.config\.|biome\.json|pint\.json|phpstan(?:-baseline|\.dist)?\.neon|php-cs-fixer|ruff\.toml|mypy\.ini|stylelintrc|stylelint\.config\.|pyproject\.toml|tool\.ruff|tool\.mypy)/i;
const msg = (nome) => `CBS: edição de ${nome} bloqueada (config de lint/format). Corrija o código em vez de afrouxar a regra. Se a mudança é legítima, rode com CBS_PERMITIR_CONFIG=1.`;

// Nome que as ferramentas enxergam. Variante de caixa (.ESLINTRC.JSON) só vale como o nome em minúsculas se abre o
// mesmo arquivo (stat segue symlink): FS case-insensitive (macOS, Windows, WSL /mnt/c, ext4 casefold), hardlink ou
// symlink para o mesmo alvo. No Linux case-sensitive é outro arquivo, que ferramenta nenhuma lê.
function nomeVisto(arquivo) {
  const b = path.basename(arquivo);
  const min = b.toLowerCase();
  if (min === b) return b;
  try {
    const a = fs.statSync(arquivo, { bigint: true });
    const m = fs.statSync(path.join(path.dirname(arquivo), min), { bigint: true });
    return a.dev === m.dev && a.ino === m.ino ? min : b;
  } catch { return b; }
}
export function ehProtegido(arquivo) {
  const b = nomeVisto(arquivo);
  return PROTEGIDOS.some((re) => re.test(b));
}
function realOuNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}
// Chave canônica de um caminho (realpath quando existe). Sem exceção no caminho inexistente: 200k operações
// de patch custavam segundos só em ENOENT lançado.
const chave = (p) => (existeNoDisco(p) && realOuNull(p)) || p;
// lstat: symlink quebrado conta como existente; erro que não é ENOENT também (fail closed, como o ECC)
function existeNoDisco(p) {
  try { return fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined; } catch { return true; }
}


// ---- orçamento de tempo: estourou → bloqueia (o timeout do hook, ao contrário, deixaria passar) ----
const PRAZO_MS = 3000;
class Prazo extends Error {}
let limite = Infinity;
function prazo() {
  if (Date.now() >= limite) throw new Prazo();
}

// ---- pyproject.toml: [tool.ruff*]/[tool.mypy*] comparadas antes/depois da edição ----

// Fim da string TOML que começa em i ("..", '..', """..""", '''..'''); string de uma linha para no \n.
function fimDaString(s, i) {
  const q = s[i];
  const tripla = s.startsWith(q + q + q, i);
  for (let j = i + (tripla ? 3 : 1); j < s.length; j++) {
    if (!tripla && s[j] === '\n') return j;
    if (q === '"' && s[j] === '\\' && (tripla || s[j + 1] !== '\n')) { j++; continue; }
    if (!tripla && s[j] === q) return j + 1;
    if (tripla && s.startsWith(q + q + q, j)) { let f = j + 3; if (s[f] === q) f++; if (s[f] === q) f++; return f; }
  }
  return s.length;
}
// Declarações do TOML — cabeçalho [..]/[[..]] ou chave = valor com o valor multilinha inteiro — e a chave completa
// de cada uma. Linha vazia e comentário solto ficam de fora; colchete dentro de string/comentário não conta.
function declaracoes(toml) {
  const s = String(toml).replace(/\r\n/g, '\n');
  const out = [];
  let tabela = '';
  for (let i = 0; i < s.length;) {
    if (' \t\n'.includes(s[i])) { i++; continue; }
    prazo();
    const ini = i;
    let prof = 0;
    while (i < s.length && (s[i] !== '\n' || prof > 0)) {
      const c = s[i];
      if (c === '#') { const f = s.indexOf('\n', i); i = f < 0 ? s.length : f; }
      else if (c === '"' || c === "'") i = fimDaString(s, i);
      else { if (c === '[' || c === '{') prof++; else if ((c === ']' || c === '}') && prof > 0) prof--; i++; }
    }
    const texto = s.slice(ini, i);
    if (texto[0] === '#') continue;
    const cabecalho = texto[0] === '[';
    const nome = (cabecalho ? /^\[\[?([^\]]*)/.exec(texto)[1] : texto.split('=')[0]).replace(/["'\s]/g, '');
    if (cabecalho) tabela = nome;
    out.push({ texto, chave: cabecalho || !tabela ? nome : `${tabela}.${nome}` });
  }
  return out;
}
// Protegida: chave completa sob tool.ruff/tool.mypy ou prefixo delas — `[tool]`, `[[tool]]`, `tool = {..}` mudam onde
// tool.ruff/tool.mypy moram; `[[tool.ruff]]` já cai no primeiro caso. Chave com escape (\u..) também (fail closed).
const protegida = (d) => /^tool(?:$|\.(?:ruff|mypy))/.test(d.chave) || d.chave.includes('\\');
// Texto das declarações protegidas de um pyproject.toml.
export function secoesProtegidas(toml) {
  return declaracoes(toml).filter(protegida).map((d) => d.texto).join('\n');
}

// Edit do Claude Code: old_string tem de existir uma vez (ou replace_all). Devolve as leituras possíveis (null = não
// aplica): com new_string vazio o Claude Code também apaga o \n seguinte ao trecho — as duas leituras são conferidas.
function aplicarEdit(texto, e) {
  const lf = (v) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n') : null);
  const [t, velho, novo] = [lf(texto), lf(e?.old_string), lf(e?.new_string)];
  if (t === null || velho === null || novo === null) return null;
  if (!velho) return t.trim() ? null : [novo];
  const partes = t.split(velho);
  if (partes.length < 2 || (partes.length > 2 && e.replace_all !== true)) return null;
  const leituras = [partes.join(novo)];
  if (!novo && !velho.endsWith('\n') && t.includes(velho + '\n')) {
    const p2 = t.split(velho + '\n');
    leituras.push(e.replace_all === true ? p2.join('') : p2[0] + p2.slice(1).join(velho + '\n'));
  }
  return leituras;
}
// Edits em sequência (Edit = 1, MultiEdit = n). Leitura em que um edit não aplica sai (nela o Claude Code falharia
// sem mudar nada); nenhuma sobra → não aplica.
function aplicarEdits(texto, edits) {
  let atuais = [texto];
  for (const e of edits) {
    atuais = [...new Set(atuais.flatMap((t) => aplicarEdit(t, e) || []))];
    if (atuais.length > 64) throw new Prazo();
  }
  return atuais;
}

// ---- apply_patch do Codex: parser e aplicação compatíveis (codex-rs apply-patch: parser.rs, lib.rs, seek_sequence.rs) ----
// Espaço do Rust (`char::is_whitespace` = Unicode White_Space): é o que o Codex apara. `bom`: também U+FEFF (o trim
// do JS) — só nos cabeçalhos, onde reconhecer a mais só faz o hook conferir a mais.
const ESPACO_RUST = new Set([9, 10, 11, 12, 13, 32, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);
function aparar(s, inicio, bom) {
  const esp = (c) => ESPACO_RUST.has(c) || (bom && c === 0xfeff);
  let a = 0;
  let b = s.length;
  while (b > a && esp(s.charCodeAt(b - 1))) b--;
  while (inicio && a < b && esp(s.charCodeAt(a))) a++;
  return s.slice(a, b);
}
// Pontuação Unicode → ASCII do 4º nível do seek_sequence.
const PONTUACAO = new Map([
  [[0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212], '-'], [[0x2018, 0x2019, 0x201a, 0x201b], "'"],
  [[0x201c, 0x201d, 0x201e, 0x201f], '"'],
  [[0xa0, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000], ' '],
].flatMap(([cs, r]) => cs.map((c) => [String.fromCharCode(c), r])));
const NIVEIS = [
  (s) => s, (s) => aparar(s, false), (s) => aparar(s, true),
  (s) => [...aparar(s, true)].map((c) => PONTUACAO.get(c) ?? c).join(''),
];
// Linhas do arquivo normalizadas por nível + índice linha → posições (calculado uma vez por arquivo).
const cacheNiveis = new WeakMap();
function nivel(linhas, n) {
  let c = cacheNiveis.get(linhas);
  if (!c) cacheNiveis.set(linhas, (c = []));
  if (!c[n]) {
    const norm = linhas.map(NIVEIS[n]);
    const pos = new Map();
    norm.forEach((l, i) => { const v = pos.get(l); if (v) v.push(i); else pos.set(l, [i]); });
    c[n] = { norm, pos };
  }
  return c[n];
}
// seek_sequence: 1ª posição >= de onde o alvo casa, nível a nível. Só verifica as posições da linha mais rara do alvo.
function buscar(linhas, alvo, de, fim) {
  if (!alvo.length) return de;
  if (alvo.length > linhas.length) return -1;
  const ini = fim ? linhas.length - alvo.length : de;
  const max = linhas.length - alvo.length;
  for (let n = 0; n < NIVEIS.length; n++) {
    prazo();
    const { norm, pos } = nivel(linhas, n);
    const a = alvo.map(NIVEIS[n]);
    let ancora = 0;
    let menor = Infinity;
    for (let k = 0; k < a.length && menor; k++) {
      const q = pos.get(a[k])?.length ?? 0;
      if (q < menor) { menor = q; ancora = k; }
    }
    if (!menor) continue;
    for (const p of pos.get(a[ancora])) {
      const i = p - ancora;
      if (i < ini) continue;
      if (i > max) break;
      prazo();
      let k = 0;
      while (k < a.length && norm[i + k] === a[k]) k++;
      if (k === a.length) return i;
    }
  }
  return -1;
}
// Operações dos patches de um texto, linha a linha como o parser do Codex: o patch começa na linha que termina em
// "*** Begin Patch" e acaba em "*** End Patch" em posição de cabeçalho (" *** End Patch" num hunk é contexto).
// null = o Codex rejeitaria.
function operacoes(texto, cwd) {
  const linhas = texto.replace(/\r\n/g, '\n').split('\n');
  const ops = [];
  const abs = (p) => path.resolve(cwd, p);
  let dentro = false;
  let achou = false;
  for (let i = 0; i < linhas.length;) {
    prazo();
    const cab = aparar(linhas[i++], true, true);
    if (!dentro) {
      if (cab.endsWith('*** Begin Patch')) dentro = achou = true;
      else if (achou && cab.startsWith('*** ')) return null; // cabeçalho depois do End Patch: o Codex rejeita
      continue;
    }
    if (cab === '*** End Patch') { dentro = false; continue; }
    if (cab.startsWith('*** Add File: ')) {
      let conteudo = '';
      for (; i < linhas.length && linhas[i].startsWith('+'); i++) conteudo += linhas[i].slice(1) + '\n';
      ops.push({ tipo: 'Add', arquivo: abs(cab.slice(14)), conteudo });
    } else if (cab.startsWith('*** Delete File: ')) {
      ops.push({ tipo: 'Delete', arquivo: abs(cab.slice(17)) });
    } else if (cab.startsWith('*** Update File: ')) {
      const op = { tipo: 'Update', arquivo: abs(cab.slice(17)), destino: null, hunks: [] };
      if (linhas[i]?.startsWith('*** Move to: ')) op.destino = abs(linhas[i++].slice(13));
      while (i < linhas.length && !linhas[i].startsWith('***')) {
        if (!aparar(linhas[i], true, true)) { i++; continue; }
        const h = { ctx: null, ctxVazio: false, velho: [], novo: [], fim: false };
        // "@@" + só espaço: sem contexto no Codex 0.156 (medido); versões antigas liam contexto = linha em branco
        if (aparar(linhas[i], false) === '@@') h.ctxVazio = linhas[i++] !== '@@';
        else if (linhas[i].startsWith('@@ ')) h.ctx = linhas[i++].slice(3);
        else if (op.hunks.length) return null;
        let n = 0;
        for (; i < linhas.length; i++, n++) {
          const l = linhas[i];
          if (l === '*** End of File') { if (n) { h.fim = true; i++; } break; }
          if (l === '' || l[0] === ' ') { h.velho.push(l.slice(1)); h.novo.push(l.slice(1)); } // linha vazia = contexto
          else if (l[0] === '+') h.novo.push(l.slice(1));
          else if (l[0] === '-') h.velho.push(l.slice(1));
          else break;
        }
        if (!n) return null;
        op.hunks.push(h);
      }
      if (!op.hunks.length) return null;
      ops.push(op);
    } else return null;
  }
  return achou && !dentro ? ops : null;
}
// Conteúdo depois dos hunks (compute_replacements + apply_replacements). null = não aplica.
// `antigo`: lê "@@ " como contexto linha em branco (Codex antigo).
function aplicarHunks(texto, hunks, antigo) {
  const linhas = texto.split('\n');
  if (linhas[linhas.length - 1] === '') linhas.pop();
  const trocas = [];
  let pos = 0;
  for (const h of hunks) {
    const ctx = h.ctx ?? (antigo && h.ctxVazio ? '' : null);
    if (ctx !== null) { const c = buscar(linhas, [ctx], pos, false); if (c < 0) return null; pos = c + 1; }
    if (!h.velho.length) { // acréscimo puro: fim do arquivo
      trocas.push([linhas.length && linhas[linhas.length - 1] === '' ? linhas.length - 1 : linhas.length, 0, h.novo]);
      continue;
    }
    let { velho, novo } = h;
    let i = buscar(linhas, velho, pos, h.fim);
    if (i < 0 && velho[velho.length - 1] === '') {
      velho = velho.slice(0, -1);
      if (novo[novo.length - 1] === '') novo = novo.slice(0, -1);
      i = buscar(linhas, velho, pos, h.fim);
    }
    if (i < 0) return null;
    trocas.push([i, velho.length, novo]);
    pos = i + velho.length;
  }
  // Reconstrói numa passada, em ordem crescente (o splice por hunk era O(linhas × hunks) e o spread de `novo`
  // estourava a pilha). Trocas sobrepostas (*** End of File fora de ordem) fogem do que o Codex garante → não aplica.
  trocas.sort((a, b) => a[0] - b[0]);
  const out = [];
  let de = 0;
  for (const [i, n, novo] of trocas) {
    prazo();
    if (i < de) return null;
    for (; de < i; de++) out.push(linhas[de]);
    for (const l of novo) out.push(l);
    de = i + n;
  }
  for (; de < linhas.length; de++) out.push(linhas[de]);
  if (out[out.length - 1] !== '') out.push('');
  return out.join('\n');
}
// Textos do payload que trazem patch (input, patch, command).
function textosDePatch(payload) {
  const ti = payload.tool_input || {};
  return [ti.input, ti.patch, comandoBash(payload)].filter((v) => typeof v === 'string' && v.includes('*** Begin Patch'));
}
// Operações de todos os patches. undefined = sem patch; null = patch que o Codex rejeitaria.
function opsDoPayload(textos, cwd) {
  if (!textos.length) return undefined;
  const ops = [];
  for (const t of textos) {
    const o = operacoes(t, cwd);
    if (!o) return null;
    for (const op of o) ops.push(op); // sem spread: 200k operações estouram a pilha
  }
  return ops;
}
// Toda linha com cara de cabeçalho de patch (aparada como o Rust + U+FEFF) conta como tocando o arquivo, mesmo onde
// o parser não chega (fail closed).
function caminhosCitados(textos, cwd) {
  const out = [];
  for (const t of textos) {
    for (const l of t.split('\n')) {
      prazo();
      const m = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/.exec(aparar(l, true, true));
      if (m) out.push(path.resolve(cwd, m[1]));
    }
  }
  return out;
}
// Aplica as operações em memória, na ordem do Codex: Map chave → conteúdo (null = apagado). null = não aplica.
function simular(ops, antigo) {
  const vfs = new Map();
  for (const op of ops) {
    prazo();
    const k = chave(op.arquivo);
    if (op.tipo !== 'Update') { vfs.set(k, op.tipo === 'Add' ? op.conteudo : null); continue; }
    const atual = vfs.has(k) ? vfs.get(k) : existeNoDisco(op.arquivo) ? lerTexto(op.arquivo) : null;
    const novo = atual === null ? null : aplicarHunks(atual, op.hunks, antigo);
    if (novo === null) return null;
    vfs.set(chave(op.destino || op.arquivo), novo);
    if (op.destino) vfs.set(k, null); // Move: grava o destino e apaga a origem
  }
  return vfs;
}

function avaliar(payload) {
  const ti = payload.tool_input || {};
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const textos = textosDePatch(payload);
  const ops = opsDoPayload(textos, cwd);
  // união: caminhos do cbs-comum, do parser do Codex e de toda linha com cara de cabeçalho
  const caminhos = new Set([...caminhosEditados(payload), ...caminhosCitados(textos, cwd)]);
  for (const op of ops || []) for (const p of [op.arquivo, op.destino]) if (p) caminhos.add(p);
  let vfss;
  for (const arquivo of caminhos) {
    prazo();
    if (!existeNoDisco(arquivo)) continue; // SP-3: criação inicial não enfraquece nada (inclui destino de Move)
    // symlink: nome comum apontando para uma config conta como a config
    const alvos = [arquivo, realOuNull(arquivo)].filter(Boolean);
    const protegido = alvos.find((p) => ehProtegido(p));
    if (protegido) return { bloquear: true, motivo: msg(path.basename(protegido)) };
    if (!alvos.some((p) => nomeVisto(p) === 'pyproject.toml')) continue;
    const antes = lerTexto(arquivo);
    let depois;
    if (ops !== undefined) {
      // as duas leituras de "@@ " (Codex atual e antigo): bloqueia se qualquer uma que aplica mexe nas seções;
      // sem "@@ " no patch as duas são iguais — simula uma vez
      if (vfss === undefined) {
        const leituras = ops?.some((op) => op.hunks?.some((h) => h.ctxVazio)) ? [false, true] : [false];
        vfss = ops ? leituras.map((antigo) => simular(ops, antigo)).filter(Boolean) : [];
      }
      depois = vfss.filter((v) => v.has(chave(arquivo))).map((v) => v.get(chave(arquivo)) ?? '');
    } else if (typeof ti.content === 'string') depois = [ti.content];
    else depois = aplicarEdits(antes, Array.isArray(ti.edits) ? ti.edits : [ti]);
    if (!depois.length) {
      return { bloquear: true, motivo: msg('pyproject.toml (a edição não aplica no conteúdo atual; não dá para conferir [tool.ruff]/[tool.mypy])') };
    }
    const secoes = secoesProtegidas(antes);
    if (depois.some((d) => secoesProtegidas(d) !== secoes)) {
      return { bloquear: true, motivo: msg('pyproject.toml [tool.ruff]/[tool.mypy]') };
    }
  }
  return { bloquear: false };
}

// Payload (serializado) que cita config protegida; falha na serialização conta como citando (fail closed).
function citaProtegido(payload) {
  try { return RE_CITA_PROTEGIDO.test(JSON.stringify(payload)); } catch { return true; }
}
// `prazoMs`: orçamento da análise (padrão 3 s); estourou → bloqueia. Erro interno com config protegida citada no
// payload também bloqueia (o "erro interno → exit 0" dos hooks deixaria a edição passar); sem citar, sobe como antes.
export function avaliarEdicao(payload, { env = process.env, prazoMs = PRAZO_MS } = {}) {
  if (String(env.CBS_PERMITIR_CONFIG || '') === '1') return { bloquear: false };
  limite = Date.now() + prazoMs;
  try {
    return avaliar(payload || {});
  } catch (e) {
    if (e instanceof Prazo) return { bloquear: true, motivo: msg(`pyproject.toml (edição grande demais para conferir [tool.ruff]/[tool.mypy] em ${prazoMs / 1000} s)`) };
    if (!citaProtegido(payload)) throw e;
    return { bloquear: true, motivo: msg(`config protegida (erro interno na análise: ${e?.message ?? e})`) };
  } finally {
    limite = Infinity;
  }
}

function main() {
  if (hookDesligado('config')) return 0;
  const bruto = lerStdin();
  if (Buffer.byteLength(bruto) > LIMITE_STDIN) {
    // payload grande demais para inspecionar: fail closed só se cita config protegida (ECC bloqueia sempre)
    if (String(process.env.CBS_PERMITIR_CONFIG || '') !== '1' && RE_CITA_PROTEGIDO.test(bruto)) {
      process.stderr.write(msg('config protegida (payload grande demais para inspecionar)') + '\n');
      return 2;
    }
    return 0;
  }
  const payload = lerPayload(bruto);
  if (!payload) return 0;
  const r = avaliarEdicao(payload);
  if (!r.bloquear) return 0;
  process.stderr.write(r.motivo + '\n');
  return 2;
}

if (ehEntrada(import.meta.url)) {
  let code = 0;
  try { code = main(); } catch (e) { avisar(`config-protect: erro interno ignorado (${e.message})`); code = 0; }
  process.exit(code);
}
