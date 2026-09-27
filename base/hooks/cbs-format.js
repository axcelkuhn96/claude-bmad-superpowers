#!/usr/bin/env node
// cbs-format.js — PostToolUse (Edit|Write|MultiEdit; Codex: apply_patch): formata SÓ o arquivo editado com a
// ferramenta do próprio projeto (pint / ruff format / biome / prettier) quando há ferramenta E config; silencioso
// sem ferramenta; nunca npx. Também acumula o caminho por session_id para o typecheck do Stop.
// Detecção derivada de affaan-m/ECC @ e482e57 (scripts/lib/resolve-formatter.js, scripts/hooks/post-edit-format.js,
// scripts/hooks/post-edit-accumulator.js) — MIT License, Copyright (c) 2026 Affaan Mustafa.
// Licença: https://github.com/affaan-m/ECC/blob/e482e57/LICENSE
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { hookDesligado, lerStdin, lerPayload, lerTexto, caminhosEditados, acharRaiz, binLocal, noPath, ehEntrada, avisar, registrarEdicao } from './cbs-comum.js';

const EXT_WEB = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.json', '.md']);
const BIOME_CFG = ['biome.json', 'biome.jsonc'];
const PRETTIER_CFG = ['.prettierrc', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml', '.prettierrc.json5',
  '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', '.prettierrc.toml', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs'];
const TIMEOUT_MS = 20_000;

const tem = (raiz, nomes) => nomes.some((n) => fs.existsSync(path.join(raiz, n)));
function chavePrettierNoPackage(raiz) {
  try {
    const pkg = JSON.parse(lerTexto(path.join(raiz, 'package.json')));
    return Boolean(pkg) && Object.prototype.hasOwnProperty.call(pkg, 'prettier');
  } catch { return false; }
}

export function escolherFormatador(arquivo, env = process.env) {
  const ext = path.extname(arquivo).toLowerCase();
  const dir = path.dirname(arquivo);
  if (ext === '.php') {
    const raiz = acharRaiz(dir, ['composer.json']);
    if (!raiz) return null;
    const bin = binLocal(raiz, path.join('vendor', 'bin', 'pint'));
    if (!bin || !tem(raiz, ['pint.json', 'artisan'])) return null;
    return { ferramenta: 'pint', bin, args: [arquivo], raiz };
  }
  if (ext === '.py' || ext === '.pyi') {
    const raiz = acharRaiz(dir, ['pyproject.toml', 'ruff.toml', '.ruff.toml']);
    if (!raiz) return null;
    const configurado = tem(raiz, ['ruff.toml', '.ruff.toml']) || /^\[tool\.ruff/m.test(lerTexto(path.join(raiz, 'pyproject.toml')));
    if (!configurado) return null;
    const bin = binLocal(raiz, path.join('.venv', 'bin', 'ruff')) || noPath('ruff', env);
    if (!bin) return null;
    return { ferramenta: 'ruff', bin, args: ['format', arquivo], raiz };
  }
  if (EXT_WEB.has(ext)) {
    const raiz = acharRaiz(dir, ['package.json']);
    if (!raiz) return null;
    const biome = binLocal(raiz, path.join('node_modules', '.bin', 'biome'));
    if (biome && tem(raiz, BIOME_CFG)) return { ferramenta: 'biome', bin: biome, args: ['format', '--write', arquivo], raiz };
    const prettier = binLocal(raiz, path.join('node_modules', '.bin', 'prettier'));
    if (prettier && (tem(raiz, PRETTIER_CFG) || chavePrettierNoPackage(raiz))) return { ferramenta: 'prettier', bin: prettier, args: ['--write', arquivo], raiz };
  }
  return null;
}

function main() {
  const formatar = !hookDesligado('format');
  const acumular = !hookDesligado('typecheck');
  if (!formatar && !acumular) return 0;
  const payload = lerPayload(lerStdin());
  if (!payload) return 0;
  // Delete File e a origem de um Move não existem mais: nada a formatar nem a checar.
  const arquivos = caminhosEditados(payload).filter((a) => fs.existsSync(a));
  if (!arquivos.length) return 0;
  if (acumular) {
    try { registrarEdicao(payload.session_id, arquivos); } catch (e) { avisar(`format: acumulador não gravado (${e.code || e.message})`); }
  }
  if (!formatar) return 0;
  for (const arquivo of arquivos) {
    const f = escolherFormatador(arquivo);
    if (!f) continue;
    const r = spawnSync(f.bin, f.args, { cwd: f.raiz, stdio: 'ignore', timeout: TIMEOUT_MS, shell: false });
    if (r.error || r.status !== 0) avisar(`format: ${f.ferramenta} falhou em ${path.basename(arquivo)} (exit ${r.status ?? r.error?.code}) — arquivo mantido`);
  }
  return 0;
}

if (ehEntrada(import.meta.url)) {
  try { main(); } catch (e) { avisar(`format: erro interno ignorado (${e.message})`); }
  process.exit(0);
}
