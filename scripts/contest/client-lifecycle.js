// Observe the full IPC lifecycle, including clean exits before a result.
export function monitorClient(child, label, timeoutMs = 60_000) {
  let resolveReady, resolveDone, rejectReady, rejectDone;
  let completed = false;
  let isReady = false;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // The parent waits for all ready promises before awaiting results. Observe
  // failures immediately so an early peer failure cannot become unhandled.
  ready.catch(() => {});
  done.catch(() => {});
  const fail = (error) => { rejectReady(error); rejectDone(error); };
  const timer = setTimeout(() => {
    fail(new Error(`${label} timed out`));
    child.kill();
  }, timeoutMs);
  child.on('error', fail);
  child.on('exit', (code, signal) => {
    clearTimeout(timer);
    if (!completed) fail(new Error(`${label} exited before its result (${signal || code})`));
  });
  child.on('message', (message) => {
    if (message.type === 'ready') { isReady = true; resolveReady(message); }
    if (message.type === 'error') fail(new Error(message.message));
    if (message.type === 'done') {
      if (!isReady) { fail(new Error(`${label} sent a result before ready`)); return; }
      completed = true;
      clearTimeout(timer);
      resolveDone(message);
    }
  });
  return { ready, done };
}
