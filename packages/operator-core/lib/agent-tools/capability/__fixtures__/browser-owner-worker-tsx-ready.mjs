process.send?.({ type: 'fixture:tsx-loaded', pid: process.pid, startupAtNs: process.hrtime.bigint().toString() });
