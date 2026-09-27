#!/usr/bin/env node
// cbs-config-protect.js — PreToolUse (Edit|Write|MultiEdit; Codex: apply_patch): bloqueia enfraquecer config de lint/format.
// Escape: CBS_PERMITIR_CONFIG=1. package.json, tsconfig.json e composer.json nunca são bloqueados.
// Derivado de affaan-m/ECC @ e482e57, scripts/hooks/config-protection.js — MIT License,
// Copyright (c) 2026 Affaan Mustafa. Licença: https://github.com/affaan-m/ECC/blob/e482e57/LICENSE
import fs from 'node:fs';
import path from 'node:path';
import { hookDesligado, lerStdin, lerPayload, lerTexto, caminhosEditados, comandoBash, ehEntrada, avisar, LIMITE_STDIN } from './cbs-comum.js';

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
const chave = (p) => realOuNull(p) ?? p;
// lstat: symlink quebrado conta como existente; erro que não é ENOENT também (fail closed, como o ECC)
function existeNoDisco(p) {
  try { fs.lstatSync(p); return true; } catch (e) { return !(e && e.code === 'ENOENT'); }
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
    out.push({ texto, cabecalho, chave: cabecalho || !tabela ? nome : `${tabela}.${nome}` });
  }
  return out;
}
// [tool.ruff*], [tool.mypy*] (e [[tool.mypy.overrides]]), tool.ruff.x = na raiz, ruff.x = em [tool], `tool = {..}`
// inline na raiz; chave com escape (\u..) conta como protegida (fail closed).
const protegida = (d) => /^tool\.(?:ruff|mypy)/.test(d.chave) || d.chave.includes('\\') || (!d.cabecalho && d.chave === 'tool');
// Texto das declarações protegidas de um pyproject.toml.
export function secoesProtegidas(toml) {
  return declaracoes(toml).filter(protegida).map((d) => d.texto).join('\n');
}

// Edit do Claude Code: old_string tem de existir uma vez (ou replace_all). null = não aplica.
function aplicarEdit(texto, e) {
  const lf = (v) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n') : null);
  const [t, velho, novo] = [lf(texto), lf(e?.old_string), lf(e?.new_string)];
  if (t === null || velho === null || novo === null) return null;
  if (!velho) return t.trim() ? null : novo;
  const partes = t.split(velho);
  if (partes.length < 2 || (partes.length > 2 && e.replace_all !== true)) return null;
  return partes.join(novo);
}

// ---- apply_patch do Codex: parser e aplicação compatíveis (codex-rs apply-patch: parser.rs, lib.rs, seek_sequence.rs) ----
const NIVEIS = [
  (s) => s, (s) => s.trimEnd(), (s) => s.trim(),
  (s) => s.trim().replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\u2018-\u201B]/g, "'").replace(/[\u201C-\u201F]/g, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' '),
];
function buscar(linhas, alvo, de, fim) {
  if (!alvo.length) return de;
  if (alvo.length > linhas.length) return -1;
  const ini = fim ? linhas.length - alvo.length : de;
  for (const norm of NIVEIS) {
    for (let i = ini; i + alvo.length <= linhas.length; i++) {
      if (alvo.every((l, k) => norm(linhas[i + k]) === norm(l))) return i;
    }
  }
  return -1;
}
// Operações do corpo de um patch (entre Begin e End Patch). null = o Codex rejeitaria o patch.
function operacoes(corpo, cwd) {
  const linhas = corpo.split('\n');
  const ops = [];
  const abs = (p) => path.resolve(cwd, p);
  for (let i = 0; i < linhas.length;) {
    const cab = linhas[i++].trim();
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
        if (!linhas[i].trim()) { i++; continue; }
        const h = { ctx: null, ctxVazio: false, velho: [], novo: [], fim: false };
        // "@@" + só espaço: sem contexto no Codex 0.156 (medido); versões antigas liam contexto = linha em branco
        if (linhas[i].trimEnd() === '@@') h.ctxVazio = linhas[i++] !== '@@';
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
  return ops;
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
  trocas.sort((a, b) => a[0] - b[0]).reverse().forEach(([i, n, novo]) => linhas.splice(i, n, ...novo));
  if (linhas[linhas.length - 1] !== '') linhas.push('');
  return linhas.join('\n');
}
// Operações de todos os patches do payload (input, patch, command). undefined = sem patch; null = patch inválido.
function opsDoPayload(payload, cwd) {
  const ti = payload.tool_input || {};
  const textos = [ti.input, ti.patch, comandoBash(payload)].filter((v) => typeof v === 'string' && v.includes('*** Begin Patch'));
  if (!textos.length) return undefined;
  const ops = [];
  for (const t of textos) {
    const corpos = [...t.replace(/\r\n/g, '\n').matchAll(/\*\*\* Begin Patch[^\n]*\n([\s\S]*?)\n[ \t]*\*\*\* End Patch/g)];
    if (!corpos.length) return null;
    for (const [, corpo] of corpos) {
      const o = operacoes(corpo, cwd);
      if (!o) return null;
      ops.push(...o);
    }
  }
  return ops;
}
// Aplica as operações em memória, na ordem do Codex: Map chave → conteúdo (null = apagado). null = não aplica.
function simular(ops, antigo) {
  const vfs = new Map();
  for (const op of ops) {
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

export function avaliarEdicao(payload, { env = process.env } = {}) {
  if (String(env.CBS_PERMITIR_CONFIG || '') === '1') return { bloquear: false };
  const ti = payload?.tool_input || {};
  const cwd = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  const ops = opsDoPayload(payload || {}, cwd);
  // união com o parser do Codex: pega cabeçalho indentado, que o Codex apara
  const caminhos = new Set(caminhosEditados(payload));
  for (const op of ops || []) for (const p of [op.arquivo, op.destino]) if (p) caminhos.add(p);
  let vfss;
  for (const arquivo of caminhos) {
    if (!existeNoDisco(arquivo)) continue; // SP-3: criação inicial não enfraquece nada (inclui destino de Move)
    // symlink: nome comum apontando para uma config conta como a config
    const alvos = [arquivo, realOuNull(arquivo)].filter(Boolean);
    const protegido = alvos.find((p) => ehProtegido(p));
    if (protegido) return { bloquear: true, motivo: msg(path.basename(protegido)) };
    if (!alvos.some((p) => nomeVisto(p) === 'pyproject.toml')) continue;
    const antes = lerTexto(arquivo);
    let depois;
    if (ops !== undefined) {
      // as duas leituras de "@@ " (Codex atual e antigo): bloqueia se qualquer uma que aplica mexe nas seções
      vfss ??= ops ? [simular(ops, false), simular(ops, true)].filter(Boolean) : [];
      depois = vfss.filter((v) => v.has(chave(arquivo))).map((v) => v.get(chave(arquivo)) ?? '');
    } else if (typeof ti.content === 'string') depois = [ti.content];
    else if (Array.isArray(ti.edits)) depois = [ti.edits.reduce((t, e) => (t === null ? null : aplicarEdit(t, e)), antes)];
    else depois = [aplicarEdit(antes, ti)];
    if (!depois.length || depois.some((d) => typeof d !== 'string')) {
      return { bloquear: true, motivo: msg('pyproject.toml (a edição não aplica no conteúdo atual; não dá para conferir [tool.ruff]/[tool.mypy])') };
    }
    if (depois.some((d) => secoesProtegidas(d) !== secoesProtegidas(antes))) {
      return { bloquear: true, motivo: msg('pyproject.toml [tool.ruff]/[tool.mypy]') };
    }
  }
  return { bloquear: false };
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
