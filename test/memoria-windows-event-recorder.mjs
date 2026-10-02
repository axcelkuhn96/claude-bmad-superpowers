// Install as an exact, user-reviewed SessionStart hook in a private fixture project.
// The Windows harness supplies a fresh nonce and marker path to its own CLI child.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

const [cli, event] = process.argv.slice(2);
const marker = process.env.CBS_MEMORIA_EVENT_MARKER;
const nonce = process.env.CBS_MEMORIA_EVENT_NONCE;
if (!['claude', 'codex'].includes(cli) || event !== 'SessionStart' ||
    !marker || !/^[a-f0-9]{32}$/.test(nonce ?? '')) process.exit(2);
let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > 1024 * 1024) process.exit(2);
}
let payload;
try { payload = JSON.parse(raw); } catch { process.exit(2); }
if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
    typeof payload.session_id !== 'string' || !payload.session_id) process.exit(2);
await fs.writeFile(marker, JSON.stringify({
  nonce, cli, event, cwd: payload.cwd, hasSessionId: true,
  payloadSha256: createHash('sha256').update(raw).digest('hex'),
}) + '\n', { flag: 'wx' });
