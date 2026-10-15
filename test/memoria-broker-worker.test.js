import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { claimBrokerWorker } from '../base/memoria/broker.mjs';
import { createBrokerWorker } from '../base/memoria/broker-worker.mjs';
import { encodeFrame } from '../base/memoria/frame.mjs';

const fixture = fileURLToPath(new URL('./memoria-broker-worker-fixture.mjs', import.meta.url));

test('uncertain child close retains a v2 guard for a new broker to reconcile', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memoria-broker-guard-'));
  await fs.mkdir(path.join(root, 'ledger'), { mode: 0o700 });
  let starts = 0;
  const start = () => {
    starts++;
    const child = new EventEmitter();
    child.pid = 1; // In-memory fixture; kill never signals an OS process.
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = () => true;
    child.kill = () => true;
    queueMicrotask(() => child.stdout.emit('data', encodeFrame({ kind: 'ready' }, undefined, true)));
    return child;
  };
  try {
    const first = await claimBrokerWorker(root);
    const bridge = createBrokerWorker(start);
    assert.deepEqual(await bridge.start(), { kind: 'ready' });
    assert.equal(await bridge.close(), false);
    await first.release(false);
    const moduleUrl = new URL('../base/memoria/broker.mjs', import.meta.url).href;
    const probe = spawn(process.execPath, ['--input-type=module', '-e',
      `import { claimBrokerWorker } from ${JSON.stringify(moduleUrl)};
       const claim = await claimBrokerWorker(process.argv[1]);
       process.stdout.write(claim.lockPath ? 'RECLAIMED_WITH_FLOCK' : 'UNSAFE_CLAIM');
       await claim.release(true);`, root],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    probe.stdout.on('data', chunk => { output += chunk; });
    probe.stderr.on('data', chunk => { errors += chunk; });
    const exit = await new Promise(resolve => probe.once('close', resolve));
    assert.equal(exit, 0, errors);
    assert.equal(output, 'RECLAIMED_WITH_FLOCK');
    assert.equal(starts, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Linux guard v2 is complete before spawn and legacy, partial, foreign and symlink guards fail closed',
  { skip: process.platform !== 'linux' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memoria-broker-guard-v2-'));
  const ledger = path.join(root, 'ledger');
  const file = path.join(ledger, 'encoder-worker.guard');
  await fs.mkdir(ledger, { mode: 0o700 });
  try {
    const first = await claimBrokerWorker(root);
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(value.version, 2);
    assert.equal(value.protocol, 'worker-flock-v1');
    assert.equal(typeof first.lockPath, 'string');
    assert.equal((await fs.stat(first.lockPath)).mode & 0o077, 0);
    assert.equal((await fs.stat(file)).mode & 0o077, 0);
    await first.release(false);
    const replacement = await claimBrokerWorker(root);
    await assert.rejects(first.release(true), /worker_guard_changed/);
    await replacement.release(true);
    await fs.writeFile(`${file}.interrupted.tmp`, '{', { mode: 0o600 });
    const recovered = await claimBrokerWorker(root);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).version, 2);
    await recovered.release(true);
    for (const bytes of ['{"state":"worker_may_be_live"}\n', '{',
      '{"version":2,"protocol":"foreign","state":"worker_may_be_live"}']) {
      await fs.writeFile(file, bytes, { mode: 0o600 });
      await assert.rejects(claimBrokerWorker(root));
      assert.equal(await fs.readFile(file, 'utf8'), bytes);
    }
    await fs.rm(file);
    const target = path.join(root, 'target');
    await fs.writeFile(target, '{"version":2,"protocol":"worker-flock-v1"}');
    await fs.symlink(target, file);
    await assert.rejects(claimBrokerWorker(root));
    await fs.rm(file);
    await fs.rm(first.lockPath);
    await fs.symlink(target, first.lockPath);
    await assert.rejects(claimBrokerWorker(root));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Linux orphan worker holds flock before E5; recovered guard cannot load another encoder',
  { skip: process.platform !== 'linux' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memoria-worker-lifetime-'));
  const ledger = path.join(root, 'ledger');
  const marker = path.join(root, 'e5-marker');
  const exitMarker = path.join(root, 'atexit-enter');
  const exitRelease = path.join(root, 'atexit-release');
  const delayedMarker = path.join(root, 'before-flock');
  const delayedRelease = path.join(root, 'allow-flock');
  const workerPath = fileURLToPath(new URL('../base/memoria/python/worker.py', import.meta.url));
  const code = `import atexit, importlib.util, os, sys, time, types
m=types.ModuleType('mem0_adapter')
m.FINGERPRINT='fixture'
def make_e5():
    with open(os.environ['E5_MARKER'],'a') as file: file.write('e5\\n')
    return object()
m.E5Embedder=make_e5
sys.modules['mem0_adapter']=m
spec=importlib.util.spec_from_file_location('fixture_worker',sys.argv[1])
worker=importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
if os.environ.get('E5_DELAY_LOCK') == '1':
    acquire=worker.acquire_worker_lifetime_lock
    def delayed_acquire():
        with open(os.environ['E5_DELAY_MARKER'],'w') as file: file.write('waiting')
        until=time.monotonic()+5
        while not os.path.exists(os.environ['E5_DELAY_RELEASE']) and time.monotonic()<until:
            time.sleep(.01)
        return acquire()
    worker.acquire_worker_lifetime_lock=delayed_acquire
if os.environ.get('E5_HOLD_ATEXIT') == '1':
    def hold_exit():
        with open(os.environ['E5_EXIT_MARKER'],'w') as file: file.write('entered')
        until=time.monotonic()+5
        while not os.path.exists(os.environ['E5_EXIT_RELEASE']) and time.monotonic()<until:
            time.sleep(.01)
    atexit.register(hold_exit)
raise SystemExit(worker.main())`;
  const launch = (lockPath, { holdExit = false, delayLock = false } = {}) =>
    spawn('python3', ['-c', code, workerPath], {
    env: { ...process.env, CBS_MEMORIA_WORKER_LOCK: lockPath, E5_MARKER: marker,
      E5_HOLD_ATEXIT: holdExit ? '1' : '0', E5_EXIT_MARKER: exitMarker,
      E5_EXIT_RELEASE: exitRelease, E5_DELAY_LOCK: delayLock ? '1' : '0',
      E5_DELAY_MARKER: delayedMarker, E5_DELAY_RELEASE: delayedRelease },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const outcome = child => new Promise(resolve => {
    let stdout = Buffer.alloc(0);
    let stderr = '';
    child.stdout.on('data', chunk => { stdout = Buffer.concat([stdout, chunk]); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  const ready = child => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture_worker_ready_timeout')), 3000);
    child.stdout.once('data', chunk => { clearTimeout(timer); resolve(chunk); });
    child.once('close', code => { clearTimeout(timer); reject(new Error(`fixture_worker_exit:${code}`)); });
  });
  const admitted = child => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture_worker_admission_timeout')), 3000);
    child.stdout.once('data', chunk => { clearTimeout(timer); resolve({ kind: 'ready', chunk }); });
    child.once('close', code => { clearTimeout(timer); resolve({ kind: 'closed', code }); });
  });
  const waitForFile = async file => {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (await fs.stat(file).then(() => true, () => false)) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('fixture_signal_not_observed');
  };
  await fs.mkdir(ledger, { mode: 0o700 });
  let holder;
  let missing;
  let challenger;
  let duringExit;
  let successor;
  let delayed;
  let fresh;
  let bootstrapOld;
  let bootstrapNew;
  try {
    const first = await claimBrokerWorker(root);
    missing = launch('');
    assert.notEqual((await outcome(missing)).code, 0);
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
    holder = launch(first.lockPath, { holdExit: true });
    assert.match((await ready(holder)).toString(), /M0BR/);
    assert.equal((await fs.readFile(marker, 'utf8')).trim(), 'e5');
    await first.release(false); // The broker dies; the Python process is still alive.
    const replacement = await claimBrokerWorker(root);
    challenger = launch(replacement.lockPath);
    const rejected = await outcome(challenger);
    assert.notEqual(rejected.code, 0);
    assert.equal(rejected.stdout.length, 0);
    assert.equal((await fs.readFile(marker, 'utf8')).trim(), 'e5');
    const holderClosed = outcome(holder);
    holder.stdin.end();
    await waitForFile(exitMarker);
    assert.equal(holder.exitCode, null);
    duringExit = launch(replacement.lockPath);
    assert.equal((await admitted(duringExit)).kind, 'closed');
    assert.equal((await fs.readFile(marker, 'utf8')).trim(), 'e5');
    await fs.writeFile(exitRelease, 'done');
    assert.equal((await holderClosed).code, 0);
    successor = launch(replacement.lockPath);
    assert.match((await ready(successor)).toString(), /M0BR/);
    assert.equal((await fs.readFile(marker, 'utf8')).trim().split('\n').length, 2);
    const successorClosed = outcome(successor);
    successor.stdin.end();
    assert.equal((await successorClosed).code, 0);
    await replacement.release(true);
    const crashedBeforeSpawn = await claimBrokerWorker(root);
    const current = await claimBrokerWorker(root);
    delayed = launch(crashedBeforeSpawn.lockPath);
    fresh = launch(current.lockPath);
    const [oldResult, newResult] = await Promise.all([admitted(delayed), admitted(fresh)]);
    assert.deepEqual([oldResult.kind, newResult.kind].sort(), ['closed', 'ready']);
    assert.equal((await fs.readFile(marker, 'utf8')).trim().split('\n').length, 3);
    const winner = oldResult.kind === 'ready' ? delayed : fresh;
    const winnerClosed = outcome(winner);
    winner.stdin.end();
    assert.equal((await winnerClosed).code, 0);
    await current.release(true);
    const beforeSpawn = await claimBrokerWorker(root);
    bootstrapOld = launch(beforeSpawn.lockPath, { delayLock: true });
    await waitForFile(delayedMarker);
    const afterCrash = await claimBrokerWorker(root);
    bootstrapNew = launch(afterCrash.lockPath);
    assert.match((await ready(bootstrapNew)).toString(), /M0BR/);
    await fs.writeFile(delayedRelease, 'go');
    assert.notEqual((await outcome(bootstrapOld)).code, 0);
    assert.equal((await fs.readFile(marker, 'utf8')).trim().split('\n').length, 4);
    const bootstrapNewClosed = outcome(bootstrapNew);
    bootstrapNew.stdin.end();
    assert.equal((await bootstrapNewClosed).code, 0);
    await afterCrash.release(true);
  } finally {
    await fs.writeFile(exitRelease, 'done').catch(() => {});
    await fs.writeFile(delayedRelease, 'go').catch(() => {});
    for (const child of [holder, missing, challenger, duringExit, successor, delayed, fresh,
      bootstrapOld, bootstrapNew]) {
      if (child && child.exitCode === null) { child.stdin.end(); child.kill(); }
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('confirmed child close releases the shared guard for the next broker', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memoria-broker-guard-'));
  await fs.mkdir(path.join(root, 'ledger'), { mode: 0o700 });
  let starts = 0;
  const start = () => {
    starts++;
    return spawn(process.execPath, [fixture], { stdio: ['pipe', 'pipe', 'ignore'] });
  };
  try {
    const first = await claimBrokerWorker(root);
    const bridge = createBrokerWorker(start);
    assert.deepEqual(await bridge.start(), { kind: 'ready' });
    assert.equal(await bridge.close(), true);
    await first.release(true);
    const second = await claimBrokerWorker(root);
    const next = createBrokerWorker(start);
    try {
      assert.deepEqual(await next.start(), { kind: 'ready' });
      assert.equal(starts, 2);
    } finally { await second.release(await next.close()); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a worker deadline kills only its worker and the next request gets a ready replacement', async () => {
  let started = 0;
  let active = 0;
  let peak = 0;
  let fatal = 0;
  const bridge = createBrokerWorker(() => {
    started++;
    active++;
    peak = Math.max(peak, active);
    const child = spawn(process.execPath, [fixture, started === 2 ? '250' : '0'],
      { stdio: ['pipe', 'pipe', 'ignore'] });
    child.once('close', () => active--);
    return child;
  }, { coldMs: 2000, onFatal: () => fatal++ });
  try {
    assert.deepEqual(await bridge.start(), { kind: 'ready' });
    const first = await bridge.request({ id: 1, hang: true }, Buffer.from('key'), Date.now() + 80);
    assert.deepEqual(first, { kind: 'unavailable', reason: 'deadline' });
    const cold = await bridge.request({ id: 2 }, Buffer.from('key'), Date.now() + 100);
    assert.deepEqual(cold, { kind: 'unavailable', reason: 'deadline' });
    const second = await bridge.request({ id: 2 }, Buffer.from('key'), Date.now() + 3000);
    assert.deepEqual(second, { kind: 'result', id: 2, secretLength: 3 });
    assert.equal(started, 2);
    assert.equal(peak, 1);
    assert.equal(fatal, 0);
  } finally { await bridge.close(); }
  assert.equal(active, 0);
});

test('late output from an expired worker never answers the replacement request', async () => {
  let started = 0;
  let active = 0;
  let peak = 0;
  const bridge = createBrokerWorker(() => {
    started++;
    active++;
    peak = Math.max(peak, active);
    const child = spawn(process.execPath, [fixture, '0', started === 1 ? 'late' : 'normal'],
      { stdio: ['pipe', 'pipe', 'ignore'] });
    child.once('close', () => active--);
    return child;
  }, { coldMs: 2000 });
  try {
    assert.deepEqual(await bridge.start(), { kind: 'ready' });
    assert.deepEqual(await bridge.request({ id: 1, lateMs: 150 }, Buffer.from('key'), Date.now() + 60),
      { kind: 'unavailable', reason: 'deadline' });
    assert.deepEqual(await bridge.request({ id: 2 }, Buffer.from('key'), Date.now() + 2000),
      { kind: 'result', id: 2, secretLength: 3 });
    assert.equal(started, 2);
    assert.equal(peak, 1);
  } finally { await bridge.close(); }
  assert.equal(active, 0);
});

test('a replacement that never becomes ready closes the owning endpoint', async () => {
  let started = 0;
  let fatal = 0;
  const bridge = createBrokerWorker(() => {
    started++;
    return started === 1
      ? spawn(process.execPath, [fixture], { stdio: ['pipe', 'pipe', 'ignore'] })
      : spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
        { stdio: ['pipe', 'pipe', 'ignore'] });
  }, { coldMs: 120, onFatal: () => fatal++ });
  try {
    assert.deepEqual(await bridge.start(), { kind: 'ready' });
    assert.deepEqual(await bridge.request({ hang: true }, Buffer.from('key'), Date.now() + 60),
      { kind: 'unavailable', reason: 'deadline' });
    assert.deepEqual(await bridge.request({ id: 3 }, Buffer.from('key'), Date.now() + 1000),
      { kind: 'unavailable', reason: 'worker_cold' });
    assert.equal(started, 2);
    assert.equal(fatal, 1);
    assert.equal((await bridge.request({ id: 4 }, Buffer.from('key'), Date.now() + 1000)).kind,
      'unavailable');
    assert.equal(started, 2);
    assert.equal(fatal, 1);
  } finally { await bridge.close(); }
});
test('synchronous replacement spawn failure closes recovery without a third worker', async () => {
  let started = 0;
  let fatal = 0;
  const bridge = createBrokerWorker(() => {
    started++;
    if (started > 1) throw new Error('spawn failed');
    return spawn(process.execPath, [fixture], { stdio: ['pipe', 'pipe', 'ignore'] });
  }, { coldMs: 1000, onFatal: () => fatal++ });
  try {
    assert.deepEqual(await bridge.start(), { kind: 'ready' });
    assert.deepEqual(await bridge.request({ hang: true }, Buffer.from('key'), Date.now() + 60),
      { kind: 'unavailable', reason: 'deadline' });
    assert.equal((await bridge.request({ id: 2 }, Buffer.from('key'), Date.now() + 1000)).kind,
      'unavailable');
    assert.equal((await bridge.request({ id: 3 }, Buffer.from('key'), Date.now() + 1000)).kind,
      'unavailable');
    assert.equal(started, 2);
    assert.equal(fatal, 1);
  } finally { await bridge.close(); }
});

test('an owned child that never closes makes recovery fatal without replacement and permits bounded shutdown', async () => {
  let started = 0;
  let fatal = 0;
  const signals = [];
  const bridge = createBrokerWorker(() => {
    started++;
    const child = new EventEmitter();
    child.pid = 1; // In-memory child fixture; kill never signals an OS process.
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = () => true;
    child.kill = signal => { signals.push(signal ?? 'SIGTERM'); return true; };
    queueMicrotask(() => child.stdout.emit('data', encodeFrame({ kind: 'ready' }, undefined, true)));
    return child;
  }, { onFatal: () => fatal++ });
  assert.deepEqual(await bridge.start(), { kind: 'ready' });
  assert.deepEqual(await bridge.request({ hang: true }, Buffer.from('key'), Date.now() + 30),
    { kind: 'unavailable', reason: 'deadline' });
  assert.deepEqual(await bridge.request({ id: 2 }, Buffer.from('key'), Date.now() + 5500),
    { kind: 'unavailable', reason: 'worker_unstoppable' });
  assert.equal(started, 1);
  assert.equal(fatal, 1);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(await bridge.request({ id: 3 }, Buffer.from('key'), Date.now() + 1000),
    { kind: 'unavailable', reason: 'worker_unstoppable' });
  assert.equal(started, 1);
  let timer;
  try {
    assert.equal(await Promise.race([bridge.close().then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); })]), true);
  } finally { clearTimeout(timer); }
  assert.equal(fatal, 1);
});

test('close finishes within the termination bound when its owned child never closes', async () => {
  const child = new EventEmitter();
  child.pid = 1; // In-memory child fixture; kill never signals an OS process.
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  child.kill = () => true;
  const bridge = createBrokerWorker(() => {
    queueMicrotask(() => child.stdout.emit('data', encodeFrame({ kind: 'ready' }, undefined, true)));
    return child;
  });
  assert.deepEqual(await bridge.start(), { kind: 'ready' });
  let timer;
  try {
    assert.equal(await Promise.race([bridge.close().then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), 5500); })]), true);
  } finally { clearTimeout(timer); }
});

test('a request that discovers an unclosed exited worker keeps its absolute deadline', async () => {
  const child = new EventEmitter();
  child.pid = 1; // In-memory child fixture; no OS process is signaled.
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  child.kill = () => { throw new Error('exited fixture must not be signaled'); };
  const bridge = createBrokerWorker(() => {
    queueMicrotask(() => child.stdout.emit('data', encodeFrame({ kind: 'ready' }, undefined, true)));
    return child;
  });
  assert.deepEqual(await bridge.start(), { kind: 'ready' });
  child.exitCode = 1;
  child.emit('exit');
  const startedAt = Date.now();
  const result = await bridge.request({ id: 1 }, Buffer.from('key'), startedAt + 100);
  assert.deepEqual(result, { kind: 'unavailable', reason: 'deadline' });
  assert.ok(Date.now() - startedAt < 1000);
  await bridge.close();
});

test('a response observed after the absolute deadline cannot return late output', async () => {
  const bridge = createBrokerWorker(() => {
    const child = new EventEmitter();
    child.pid = 1; // In-memory child fixture; kill never signals an OS process.
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = () => {
      const actualNow = Date.now;
      Date.now = () => actualNow() + 100;
      try { child.stdout.emit('data', encodeFrame({ kind: 'result', id: 1 }, undefined, true)); }
      finally { Date.now = actualNow; }
      return true;
    };
    child.kill = () => {
      child.signalCode = 'SIGTERM';
      queueMicrotask(() => { child.emit('exit'); child.emit('close'); });
      return true;
    };
    queueMicrotask(() => child.stdout.emit('data', encodeFrame({ kind: 'ready' }, undefined, true)));
    return child;
  });
  try {
    assert.deepEqual(await bridge.start(), { kind: 'ready' });
    assert.deepEqual(await bridge.request({ id: 1 }, Buffer.from('key'), Date.now() + 50),
      { kind: 'unavailable', reason: 'deadline' });
  } finally { await bridge.close(); }
});
