#!/usr/bin/env node
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { activateProject } from './setup.mjs';

export async function main(args = process.argv.slice(2)) {
  if (process.platform !== 'win32') {
    process.stdout.write('blocked: local_native_gate_failed\n');
    return 1;
  }
  const cli = args.includes('--cli') ? args[args.indexOf('--cli') + 1] : undefined;
  const cwd = args.includes('--project') ? args[args.indexOf('--project') + 1] : undefined;
  if (!['claude', 'codex'].includes(cli) || !cwd || cwd.startsWith('--')) {
    process.stderr.write('Uso: node base/memoria/activate.mjs --cli claude|codex --project /caminho/git\n');
    return 2;
  }
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const result = await activateProject(cwd, { cli, readSecret: (name) => process.env[name],
      approve: async (tuple) => {
        process.stdout.write(`Projeto: ${tuple.projectRoot}\nID: ${tuple.projectId}\nQdrant: ${tuple.url}\nColeção: ${tuple.collection}\nVariável da chave: ${tuple.apiKeyEnv}\n`);
        const answer = await input.question(`Para validar este destino local, digite o ID ${tuple.projectId}: `);
        return answer === tuple.projectId ? tuple : null;
      },
    });
    process.stdout.write(`${result.kind}: ${result.reason ?? result.projectId}\n`);
    if (result.kind === 'activated' && cli === 'codex') {
      process.stdout.write('Revise os hooks distribuídos pelo CBS no /hooks do Codex antes da nova sessão.\n');
    }
    return result.kind === 'activated' ? 0 : 1;
  } finally { input.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
