const blocked = reason => ({ kind: 'unavailable', reason });

// One worker request at a time, with at most two requests waiting.
export function createBrokerQueue(handle) {
  const waiting = [];
  let running = false;

  function remove(entry) {
    const index = waiting.indexOf(entry);
    if (index < 0) return false;
    waiting.splice(index, 1);
    clearTimeout(entry.timer);
    entry.signal.removeEventListener('abort', entry.abort);
    entry.frame.secret.fill(0);
    return true;
  }

  function next() {
    if (running) return;
    const entry = waiting.shift();
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.signal.removeEventListener('abort', entry.abort);
    running = true;
    const { frame, signal, respond, deadlineAt } = entry;
    (async () => {
      try {
        if (signal.aborted) return;
        respond(deadlineAt <= Date.now() ? blocked('queue_timeout') :
          await handle({ ...frame.value, deadlineAt }, frame.secret, signal));
      } catch { respond(blocked('broker_failed')); }
      finally { frame.secret.fill(0); running = false; next(); }
    })();
  }

  return { enqueue(frame, signal, respond) {
    if (waiting.length >= 2) {
      frame.secret.fill(0);
      respond(blocked('queue_full'));
      return;
    }
    const deadlineAt = Math.min(Number(frame.value?.deadlineAt), Date.now() + 120000);
    if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) {
      frame.secret.fill(0);
      respond(blocked('deadline'));
      return;
    }
    if (signal.aborted) { frame.secret.fill(0); return; }
    const entry = { frame, signal, respond, deadlineAt, timer: null, abort: null };
    entry.abort = () => { remove(entry); };
    entry.timer = setTimeout(() => {
      if (remove(entry) && !signal.aborted) respond(blocked('queue_timeout'));
    }, Math.max(1, deadlineAt - Date.now()));
    waiting.push(entry);
    signal.addEventListener('abort', entry.abort, { once: true });
    next();
  } };
}
