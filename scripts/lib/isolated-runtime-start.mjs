/** Original Node worker stays alive until its observer pins this lifetime.
 * Loaded only by with-test-pg's isolated proof route, before command code.
 */
const token = process.env.PC_ISOLATED_RUNTIME_START_TOKEN;
if (!token || !process.send) throw new Error('isolated runtime observation channel is required');
await new Promise((resolve, reject) => {
  const finish = (error) => {
    clearTimeout(timer);
    process.off('message', acknowledge);
    process.off('disconnect', disconnected);
    if (error) reject(error);
    else resolve();
  };
  const acknowledge = message => {
    if (message?.kind !== 'isolated-worker-observed' || message.token !== token) return;
    finish(message.accepted === true ? undefined : new Error('original worker observation refused'));
  };
  const disconnected = () => finish(new Error('original worker observer disconnected'));
  const timer = setTimeout(() => finish(new Error('original worker observation timed out')), 10_000);
  process.on('message', acknowledge);
  process.once('disconnect', disconnected);
  process.send({ kind: 'isolated-worker-ready', token }, error => { if (error) finish(error); });
});
delete process.env.PC_ISOLATED_RUNTIME_START_TOKEN;
process.disconnect();
