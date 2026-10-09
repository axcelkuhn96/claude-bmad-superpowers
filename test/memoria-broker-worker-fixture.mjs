import { FrameReader, encodeFrame } from '../base/memoria/frame.mjs';

const reader = new FrameReader();
if (process.argv[3] === 'late') process.on('SIGTERM', () => {});
setTimeout(() => process.stdout.write(encodeFrame({ kind: 'ready' }, undefined, true)),
  Number(process.argv[2] ?? 0));
process.stdin.on('data', chunk => {
  for (const frame of reader.push(chunk)) {
    if (frame.value.hang) continue;
    const reply = () => process.stdout.write(encodeFrame({ kind: 'result', id: frame.value.id,
      secretLength: frame.secret.length }, undefined, true));
    if (frame.value.lateMs) {
      setTimeout(reply, frame.value.lateMs);
      setTimeout(() => process.exit(0), frame.value.lateMs + 50);
    } else reply();
    frame.secret.fill(0);
  }
});
