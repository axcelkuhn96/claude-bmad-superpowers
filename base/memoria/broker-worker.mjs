import { FrameReader, encodeFrame } from './frame.mjs';

const unavailable = reason => ({ kind: 'unavailable', reason });

export function createBrokerWorker(start, { coldMs = 30000, onFatal = () => {} } = {}) {
  let current = null;
  let ready = null;
  let restarting = null;
  let closed = false;
  let fatal = null;
  const children = new WeakMap();

  function fail(reason) {
    if (!fatal && !closed) {
      fatal = unavailable(reason);
      onFatal();
    }
    return fatal ?? unavailable('worker_exited');
  }

  function stop(child) {
    if (!child) return Promise.resolve(true);
    const state = children.get(child);
    state.cancelReady();
    if (state.closed) return Promise.resolve(true);
    if (state.stopping) return state.stopping;
    state.stopping = new Promise(resolve => {
      let settled = false;
      let termTimer;
      let killTimer;
      const finish = stopped => {
        if (settled) return;
        settled = true;
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        child.removeListener('close', onClose);
        resolve(stopped);
      };
      const onClose = () => finish(true);
      child.once('close', onClose);
      killTimer = setTimeout(() => finish(false), 4000);
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { child.kill(); }
        catch { finish(false); return; }
        if (!settled) termTimer = setTimeout(() => {
          if (state.closed || child.exitCode !== null || child.signalCode !== null) return;
          try { child.kill('SIGKILL'); }
          catch { finish(false); }
        }, 3000);
      }
    });
    return state.stopping;
  }

  function boot() {
    const child = start();
    const worker = { child, dead: false };
    current = worker;
    const state = { closed: false, stopping: null, cancelReady: null };
    children.set(child, state);
    child.once('close', () => { state.closed = true; });
    const parser = new FrameReader({ response: true });
    let settleReady;
    const readyPromise = new Promise(resolve => { settleReady = resolve; });
    const timer = setTimeout(() => settleReady(unavailable('worker_cold')), coldMs);
    let pending = null;
    let booted = false;
    const finishReady = value => {
      if (booted) return;
      booted = true;
      clearTimeout(timer);
      settleReady(value);
    };
    state.cancelReady = () => finishReady(unavailable('worker_exited'));
    child.stdout.on('data', chunk => {
      if (child !== current?.child) return;
      try {
        for (const frame of parser.push(chunk)) {
          if (!booted) finishReady(frame.value);
          else if (pending) { const finish = pending; pending = null; finish(frame.value); }
          else { worker.dead = true; void stop(child); }
        }
      } catch {
        worker.dead = true;
        finishReady(unavailable('worker_protocol'));
        if (pending) { const finish = pending; pending = null; finish(unavailable('worker_protocol')); }
        void stop(child);
      }
    });
    const failed = () => {
      if (child !== current?.child) return;
      worker.dead = true;
      finishReady(unavailable('worker_exited'));
      if (pending) { const finish = pending; pending = null; finish(unavailable('worker_exited')); }
    };
    child.once('exit', failed);
    child.once('error', failed);
    child.stdin.once('error', failed);
    return Object.assign(worker, { readyPromise, async request(request, secret, deadlineAt, beforeDispatch) {
      if (beforeDispatch) {
        try {
          const result = await beforeDispatch();
          if (result?.kind !== 'allowed') return result ?? unavailable('dispatch_denied');
        } catch { return unavailable('dispatch_denied'); }
      }
      return new Promise(resolve => {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) { resolve(unavailable('deadline')); return; }
        const timeout = setTimeout(() => {
          if (pending === finish) pending = null;
          resolve(unavailable('deadline'));
          void restart().catch(onFatal);
        }, remaining);
        const finish = value => {
          clearTimeout(timeout);
          if (Date.now() >= deadlineAt) {
            resolve(unavailable('deadline'));
            void restart().catch(onFatal);
          } else resolve(value);
        };
        pending = finish;
        try { child.stdin.write(encodeFrame(request, secret)); }
        catch { worker.dead = true; pending = null; finish(unavailable('worker_exited')); void restart().catch(onFatal); }
      });
    } });
  }

  async function restart() {
    if (closed) return unavailable('worker_exited');
    if (fatal) return fatal;
    if (restarting) return restarting;
    const old = current;
    restarting = (async () => {
      if (!await stop(old?.child)) return fail('worker_unstoppable');
      if (closed) return unavailable('worker_exited');
      let fresh;
      try { fresh = boot(); }
      catch { return fail('worker_exited'); }
      const result = await fresh.readyPromise;
      if (closed) return unavailable('worker_exited');
      if (result?.kind !== 'ready') {
        if (!await stop(fresh.child)) return fail('worker_unstoppable');
        return fail(result?.reason ?? 'worker_exited');
      }
      return result;
    })();
    try { return await restarting; }
    finally { restarting = null; }
  }

  return {
    start: async () => {
      if (closed || fatal) return fatal ?? unavailable('worker_exited');
      if (!ready) {
        try { ready = boot(); }
        catch { return fail('worker_exited'); }
        const result = await ready.readyPromise;
        if (result?.kind !== 'ready' && !await stop(ready.child)) return fail('worker_unstoppable');
        return result;
      }
      return ready.readyPromise;
    },
    request: async (request, secret, deadlineAt, beforeDispatch) => {
      if (closed) return unavailable('worker_exited');
      if (fatal) return fatal;
      if (restarting || !current || current.dead || current.child.exitCode !== null ||
          current.child.signalCode !== null) {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) return unavailable('deadline');
        let timer;
        const result = await Promise.race([restart(),
          new Promise(resolve => { timer = setTimeout(() => resolve(unavailable('deadline')), remaining); })]);
        clearTimeout(timer);
        if (result?.kind !== 'ready') return result;
      }
      if (closed) return unavailable('worker_exited');
      if (fatal) return fatal;
      return current.request(request, secret, deadlineAt, beforeDispatch);
    },
    close: async () => {
      closed = true;
      return stop(current?.child);
    },
  };
}
