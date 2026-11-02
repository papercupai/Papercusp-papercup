if (typeof process.send === 'function') {
  process.send({ type: 'fixture:process-started', pid: process.pid, startupAtNs: process.hrtime.bigint().toString() });
}
