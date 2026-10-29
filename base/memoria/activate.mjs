#!/usr/bin/env node
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { activateProject } from './setup.mjs';
import { readQdrantSecret } from './qdrant-key.mjs';

export async function main(args = process.argv.slice(2)) {
  if (!['linux', 'win32'].includes(process.platform)) {
    process.stdout.write('blocked: platform_unproved\n');
    return 1;
  }
  const cli = args.includes('--cli') ? args[args.indexOf('--cli') + 1] : undefined;
  const cwd = args.includes('--project') ? args[args.indexOf('--project') + 1] : undefined;
  if (!['claude', 'codex'].includes(cli) || !cwd || cwd.startsWith('--')) {
    process.stderr.write('Uso: node base/memoria/activate.mjs --cli claude|codex --project /caminho/git [--allow-tracked-native]\n');
    return 2;
  }
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const result = await activateProject(cwd, { cli, allowTrackedNative: args.includes('--allow-tracked-native'),
      readSecret: readQdrantSecret,
      approve: async (tuple) => {
        process.stdout.write(`Projeto: ${tuple.projectRoot}\nID: ${tuple.projectId}\nQdrant: ${tuple.url}\n${tuple.address ? `${tuple.allowPublic ? 'Endereço público' : 'Endereço privado'}: ${tuple.address}\n` : ''}Coleção: ${tuple.collection}\nVariável da chave: ${tuple.apiKeyEnv}\n`);
        const answer = await input.question(`Para validar este destino ${tuple.allowPublic ? 'público via HTTPS' : 'local'}, digite o ID ${tuple.projectId}: `);
        return answer === tuple.projectId ? tuple : null;
      },
    });
    process.stdout.write(`${result.kind}: ${result.reason ?? result.projectId}\n`);
    if (result.action) process.stdout.write(`Ação: ${result.action}\n`);
    if (result.kind === 'activated') process.stdout.write('MCP cbs_memoria registrado para novas sessões.\n');
    if (result.kind === 'activated' && cli === 'codex') {
      process.stdout.write('Revise os hooks distribuídos pelo CBS no /hooks do Codex antes da nova sessão.\n');
    }
    return result.kind === 'activated' ? 0 : 1;
  } finally { input.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
