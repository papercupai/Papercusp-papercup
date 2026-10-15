import { createWriteStream } from 'node:fs';

/**
 * Node writes to POSIX TTY stdout synchronously. A terminal that stops reading
 * can therefore stop the whole managed host, including input and interrupts.
 * Borrow its descriptor for asynchronous writes; never close the user's TTY.
 * Writable's high-water mark and the PTY's pause/resume bound pending output.
 * Injected streams and Windows keep their existing stream implementation.
 *
 * @param {{ stdout: any, pause?: () => void, resume?: () => void,
 *   onError?: (error: Error) => void, platform?: string,
 *   makeStream?: (fd: number) => any }} options
 */
export function createTerminalOutput({
  stdout, pause = () => {}, resume = () => {}, onError = () => {},
  platform = process.platform,
  makeStream = (fd) => createWriteStream('', {
    fd, autoClose: false, emitClose: false, highWaterMark: 64 * 1024,
  }),
}) {
  const borrowed = platform !== 'win32' && stdout.isTTY === true &&
    Number.isInteger(stdout.fd) && stdout.fd >= 0;
  const stream = borrowed ? makeStream(stdout.fd) : stdout;
  let blocked = false;
  let ending = false;
  let failed = false;
  /** @type {Promise<boolean> | undefined} */
  let finishPromise;
  const drain = () => {
    if (!blocked || ending || failed) return;
    blocked = false;
    resume();
  };
  const error = (failure) => {
    if (failed) return;
    failed = true;
    onError(failure);
  };
  stream.on?.('drain', drain);
  stream.on?.('error', error);

  return {
    get blocked() { return blocked; },
    write(data) {
      if (ending || failed || !data) return !blocked;
      try {
        const accepted = stream.write(data);
        if (accepted === false && !blocked) {
          blocked = true;
          pause();
        }
        return accepted !== false;
      } catch (failure) {
        error(failure);
        return false;
      }
    },
    /**
     * Flush before handing the terminal to a shell/successor, with a bounded exit.
     * @returns {Promise<boolean>}
     */
    finish(timeoutMs = 1000) {
      if (finishPromise) return finishPromise;
      ending = true;
      finishPromise = new Promise((resolve) => {
        let timer;
        let settled = false;
        const finishedDrain = () => settle(true);
        const settle = (drained) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          stream.off?.('drain', drain);
          stream.off?.('drain', finishedDrain);
          stream.off?.('error', failedDuringFinish);
          // Keep the error handler on a borrowed stream: an outstanding fs write
          // can fail after timeout, and must never become an unhandled event.
          if (!borrowed) stream.off?.('error', error);
          resolve(drained);
        };
        const failedDuringFinish = () => settle(false);
        if (failed) return settle(false);
        if (!borrowed && !blocked) return settle(true);
        timer = setTimeout(() => settle(false), timeoutMs);
        stream.once?.('error', failedDuringFinish);
        if (borrowed) stream.end(() => settle(true));
        else stream.once?.('drain', finishedDrain);
      });
      return finishPromise;
    },
  };
}
