// Detecção e instalação do plugin Superpowers
// IMPORTANTE: usamos execFile (não exec/shell) pra evitar injeção. Args vão como array.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const rodar = promisify(execFile);

export async function temBinarioClaude() {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    await rodar(cmd, ['claude']);
    return true;
  } catch {
    return false;
  }
}

export async function plugInstalado(nome) {
  try {
    const { stdout } = await rodar('claude', ['/plugin', 'list'], { timeout: 10000 });
    return stdout.toLowerCase().includes(nome.toLowerCase());
  } catch {
    return null;
  }
}

export async function tentarInstalarSuperpowers() {
  const ok = await temBinarioClaude();
  if (!ok) {
    console.log('⚠  CLI `claude` não encontrada no PATH.');
    console.log('   Dentro do Claude Code, rode manualmente:');
    console.log('     /plugin install superpowers@obra\n');
    return;
  }

  console.log('→ Tentando instalar plugin Superpowers...');
  try {
    await rodar('claude', ['/plugin', 'install', 'superpowers@obra'], { timeout: 60000 });
    console.log('✓ Plugin Superpowers solicitado (confirme dentro do Claude Code se necessário).\n');
  } catch {
    console.log('⚠  Não consegui instalar via CLI. Dentro do Claude Code, rode:');
    console.log('     /plugin install superpowers@obra\n');
  }
}

export async function tentarAtualizarSuperpowers() {
  const ok = await temBinarioClaude();
  if (!ok) {
    console.log('⚠  CLI `claude` não encontrada — pule a atualização do Superpowers.');
    return;
  }
  console.log('→ Tentando atualizar plugin Superpowers...');
  try {
    await rodar('claude', ['/plugin', 'update', 'superpowers@obra'], { timeout: 60000 });
    console.log('✓ Plugin Superpowers atualizado (ou já estava na última).');
  } catch {
    console.log('⚠  Não consegui atualizar via CLI. Dentro do Claude Code, rode:');
    console.log('     /plugin update superpowers@obra');
  }
}
