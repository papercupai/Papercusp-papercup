/** Source eligibility shared without database or provider registration imports. */
import { isAbsolute } from 'node:path';

export const safeHistoryPath = (path: string) => Boolean(path) && !isAbsolute(path) && !/[\0\r\n\\]/.test(path)
  && !path.split('/').some(part => part === '..' || part === '.' || !part);
export const eligibleHistoryPath = (path: string) => safeHistoryPath(path)
  && !/(?:^|\/)(?:node_modules|vendor|vendored|dist|build|coverage|generated|__generated__|retired|\.git)(?:\/|$)|(?:\.generated|\.gen)\./i.test(path);
