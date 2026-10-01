#!/usr/bin/env node
import { captureEvent } from './checkpoint.mjs';

const [cli, event] = process.argv.slice(2);
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 1024 * 1024) process.exit(0);
}
try {
  const result = await captureEvent({ cli, event, payload: JSON.parse(input) });
  if (result.kind === 'full' || result.kind === 'blocked' && result.reason !== 'not_mem0') {
    process.stderr.write(`CBS Mem0 capture: ${result.reason ?? result.kind}\n`);
  }
} catch (error) {
  process.stderr.write(`CBS Mem0 capture: ${error.code ?? error.message}\n`);
}
