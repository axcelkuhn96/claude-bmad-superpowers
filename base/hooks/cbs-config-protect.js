#!/usr/bin/env node
// cbs-config-protect.js — PreToolUse (Edit|Write|MultiEdit; Codex: apply_patch): bloqueia enfraquecer config de lint/format.
// Escape: CBS_PERMITIR_CONFIG=1. package.json, tsconfig.json e composer.json nunca são bloqueados.
// Derivado de affaan-m/ECC @ e482e57, scripts/hooks/config-protection.js — MIT License,
// Copyright (c) 2026 Affaan Mustafa. Licença: https://github.com/affaan-m/ECC/blob/e482e57/LICENSE
import fs from 'node:fs';
import path from 'node:path';
import { hookDesligado, lerStdin, lerPayload, lerTexto, caminhosEditados, comandoBash, ehEntrada, avisar, LIMITE_STDIN } from './cbs-comum.js';

export const PROTEGIDOS = [
  /^\.eslintrc/i, /^eslint\.config\./i, /^\.prettierrc/i, /^prettier\.config\./i, /^biome\.jsonc?$/i,
  /^pint\.json$/i, /^phpstan\.neon/i, /^phpstan-baseline\.neon$/i, /^\.php-cs-fixer/i, /^\.?ruff\.toml$/i, /^mypy\.ini$/i, /^\.stylelintrc/i,
];
const RE_CITA_PROTEGIDO = /(?:eslintrc|eslint\.config\.|prettierrc|prettier\.config\.|biome\.json|pint\.json|phpstan(?:-baseline)?\.neon|php-cs-fixer|ruff\.toml|mypy\.ini|stylelintrc|tool\.ruff|tool\.mypy)/i;
// [tool.ruff], [tool.ruff.lint], [tool.mypy], [[tool.mypy.overrides]]
const SECAO_PROTEGIDA = /^\[\[?\s*tool\.(?:ruff|mypy)\s*[.\]]/;
const CITA_SECAO = /\[\[?\s*tool\.(?:ruff|mypy)\b/;
const msg = (nome) => `CBS: edição de ${nome} bloqueada (config de lint/format). Corrija o código em vez de afrouxar a regra. Se a mudança é legítima, rode com CBS_PERMITIR_CONFIG=1.`;

export function ehProtegido(arquivo) {
  const b = path.basename(arquivo);
  return PROTEGIDOS.some((re) => re.test(b));
}
// lstat: symlink quebrado conta como existente; erro que não é ENOENT também (fail closed, como o ECC)
function existeNoDisco(p) {
  try { fs.lstatSync(p); return true; } catch (e) { return !(e && e.code === 'ENOENT'); }
}

// Para cada linha do toml: true se ela está numa seção [tool.ruff*]/[tool.mypy*] (cabeçalho incluso).
function linhasProtegidas(toml) {
  let dentro = false;
  return String(toml).split('\n').map((l) => {
    if (/^\s*\[/.test(l)) dentro = SECAO_PROTEGIDA.test(l.trim());
    return dentro;
  });
}
// Texto das seções [tool.ruff*] e [tool.mypy*] de um pyproject.toml.
export function secoesProtegidas(toml) {
  const flags = linhasProtegidas(toml);
  return String(toml).split('\n').filter((_, i) => flags[i]).join('\n');
}
// O trecho (old_string ou texto antigo de um hunk) cai, em alguma ocorrência, numa seção protegida?
function trechoTocaSecao(toml, trecho) {
  if (CITA_SECAO.test(trecho)) return true;
  const flags = linhasProtegidas(toml);
  const linhasDoTrecho = trecho.split('\n').length - 1;
  let achou = false;
  for (let i = toml.indexOf(trecho); i >= 0; i = toml.indexOf(trecho, i + 1)) {
    achou = true;
    const ini = toml.slice(0, i).split('\n').length - 1;
    if (flags.slice(ini, ini + linhasDoTrecho + 1).some(Boolean)) return true;
  }
  if (achou) return false;
  // Não achado literalmente (apply_patch tolera diferença de espaço): fail closed por linha.
  const protegidas = new Set(String(toml).split('\n').filter((_, i) => flags[i]).map((l) => l.trim()).filter(Boolean));
  return trecho.split('\n').some((l) => protegidas.has(l.trim()));
}

// Blocos por arquivo de um apply_patch do Codex: hunks com texto antigo (contexto + removidas) e linhas novas.
function blocosDoPatch(patch, cwd) {
  const blocos = [];
  let b = null;
  let h = null;
  for (const l of patch.split('\n')) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(l);
    if (m) { b = { arquivo: path.resolve(cwd, m[2].trim()), tipo: m[1], move: false, hunks: [] }; blocos.push(b); h = null; continue; }
    if (!b) continue;
    if (l.startsWith('*** Move to: ')) { b.move = true; continue; }
    if (l.startsWith('***')) continue;
    if (l.startsWith('@@')) { h = { cabecalho: l, velho: [], novo: [] }; b.hunks.push(h); continue; }
    if (!h) { h = { cabecalho: '', velho: [], novo: [] }; b.hunks.push(h); }
    if (l.startsWith('+')) h.novo.push(l.slice(1));
    else if (l.startsWith('-') || l.startsWith(' ')) h.velho.push(l.slice(1));
  }
  return blocos;
}

function pyprojectAfrouxado(arquivo, atual, payload) {
  const ti = payload.tool_input || {};
  if (typeof ti.content === 'string') return secoesProtegidas(atual) !== secoesProtegidas(ti.content);
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  for (const patch of [ti.input, ti.patch, comandoBash(payload)]) {
    if (typeof patch !== 'string' || !patch.includes('*** Begin Patch')) continue;
    for (const b of blocosDoPatch(patch, cwd)) {
      if (b.arquivo !== arquivo) continue;
      if (b.tipo === 'Delete' || b.move) { if (secoesProtegidas(atual)) return true; continue; }
      for (const h of b.hunks) {
        if (CITA_SECAO.test(h.cabecalho) || h.novo.some((l) => CITA_SECAO.test(l))) return true;
        if (h.velho.length && trechoTocaSecao(atual, h.velho.join('\n'))) return true;
      }
    }
  }
  const edits = Array.isArray(ti.edits) ? ti.edits : [ti];
  for (const e of edits) {
    const velho = typeof e?.old_string === 'string' ? e.old_string : '';
    const novo = typeof e?.new_string === 'string' ? e.new_string : '';
    if ((velho && trechoTocaSecao(atual, velho)) || CITA_SECAO.test(novo)) return true;
  }
  return false;
}

export function avaliarEdicao(payload, { env = process.env } = {}) {
  if (String(env.CBS_PERMITIR_CONFIG || '') === '1') return { bloquear: false };
  for (const arquivo of caminhosEditados(payload)) {
    const nome = path.basename(arquivo);
    const protegido = ehProtegido(arquivo);
    if (!protegido && nome.toLowerCase() !== 'pyproject.toml') continue;
    if (!existeNoDisco(arquivo)) continue; // SP-3: criação inicial não enfraquece nada (inclui destino de Move)
    if (protegido) return { bloquear: true, motivo: msg(nome) };
    if (pyprojectAfrouxado(arquivo, lerTexto(arquivo), payload)) {
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
