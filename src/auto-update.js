// Self-update do pacote: git pull (modo clone) ou npx @latest (modo npm)
import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { RAIZ_PACOTE } from './caminhos.js';

const rodar = promisify(execFile);

export async function detectarModoInstalacao() {
  try {
    await fs.access(path.join(RAIZ_PACOTE, '.git'));
    return 'git';
  } catch {}
  if (RAIZ_PACOTE.includes(`${path.sep}node_modules${path.sep}`) || RAIZ_PACOTE.includes(`${path.sep}_npx${path.sep}`)) {
    return 'npm';
  }
  return 'desconhecido';
}

async function versaoNoNpm() {
  return new Promise((resolve) => {
    const req = https.get('https://registry.npmjs.org/claude-bmad-superpowers/latest', { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.version || null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function temRemoteGit() {
  try {
    const { stdout } = await rodar('git', ['-C', RAIZ_PACOTE, 'remote'], { timeout: 5000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function tentarSelfUpdate(versaoAtual, args) {
  const modo = await detectarModoInstalacao();
  console.log(`→ Modo de instalação detectado: ${modo}`);

  if (modo === 'git') {
    if (!(await temRemoteGit())) {
      console.log('⚠  Repositório git sem remote configurado. Pulando self-update.\n');
      return { atualizou: false };
    }
    console.log('→ git pull --ff-only no clone do pacote...');
    try {
      const { stdout } = await rodar('git', ['-C', RAIZ_PACOTE, 'pull', '--ff-only'], { timeout: 30000 });
      const linhas = stdout.trim();
      console.log(linhas || '(sem saída)');
      const jaAtualizado = /up to date|atualizado/i.test(linhas);
      console.log(jaAtualizado ? '✓ Já estava na última versão.\n' : '✓ Pacote atualizado via git.\n');
      return { atualizou: !jaAtualizado };
    } catch (e) {
      console.log(`⚠  git pull falhou: ${e.message.split('\n')[0]}. Continuando.\n`);
      return { atualizou: false };
    }
  }

  if (modo === 'npm') {
    console.log('→ Consultando npm pela última versão...');
    const nova = await versaoNoNpm();
    if (!nova) {
      console.log('⚠  Não consegui consultar npm. Pulando self-update.\n');
      return { atualizou: false };
    }
    if (nova === versaoAtual) {
      console.log(`✓ Já estamos na versão mais nova publicada (${nova}).\n`);
      return { atualizou: false };
    }
    console.log(`→ Versão nova: ${versaoAtual} → ${nova}. Re-executando via npx...\n`);
    const argsRestantes = args.filter((a) => a !== '--skip-self-update');
    const result = spawnSync('npx', ['--yes', `claude-bmad-superpowers@${nova}`, ...argsRestantes, '--skip-self-update'], {
      stdio: 'inherit',
    });
    process.exit(result.status ?? 1);
  }

  console.log('⚠  Modo desconhecido (provavelmente rodando fora de clone git ou npm). Pulando self-update.\n');
  return { atualizou: false };
}
