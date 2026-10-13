#!/usr/bin/env node
import { skillHook } from './skill-hook.mjs';

const cli = process.argv[2];
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 1024 * 1024) process.exit(0);
}
try {
  const result = await skillHook(cli, JSON.parse(input),
    { stateRoot: process.env.CBS_MEMORIA_STATE_ROOT });
  if (result) process.stdout.write(JSON.stringify(result) + '\n');
} catch { /* Native hook is fail-open. */ }
