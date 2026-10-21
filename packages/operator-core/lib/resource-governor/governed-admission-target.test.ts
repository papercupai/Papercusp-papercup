// WI-6554700010018666: the process-scoped governed-admission client takes an explicit
// target from PAPERCUSP_GOVERNED_ADMISSION_DATABASE_URL, so a DSN-free process (the
// green-checkpoint suite) persists admissions to the operator DB instead of whatever
// cluster the discovery file names.
import { describe, expect, it } from 'vitest';
import {
  GOVERNED_ADMISSION_DATABASE_URL_ENV,
  governedAdmissionDatabaseUrl,
  governedProcessClientOptions,
} from './execution';

const URL = 'postgresql://harness_admin:secret@localhost:5432/papercusp';

describe('governed-admission target (WI-6554700010018666)', () => {
  it('reads the dedicated key, not the general DSN keys', () => {
    expect(GOVERNED_ADMISSION_DATABASE_URL_ENV).toBe('PAPERCUSP_GOVERNED_ADMISSION_DATABASE_URL');
    expect(governedAdmissionDatabaseUrl({ [GOVERNED_ADMISSION_DATABASE_URL_ENV]: URL })).toBe(URL);
    expect(governedAdmissionDatabaseUrl({ HARNESS_ADMIN_DATABASE_URL: URL, DATABASE_URL: URL })).toBeUndefined();
  });

  it('treats a blank value as unset', () => {
    expect(governedAdmissionDatabaseUrl({ [GOVERNED_ADMISSION_DATABASE_URL_ENV]: '   ' })).toBeUndefined();
  });

  it('passes the explicit target to the dedicated client', () => {
    expect(governedProcessClientOptions({ [GOVERNED_ADMISSION_DATABASE_URL_ENV]: ` ${URL} ` })).toEqual({ max: 2, url: URL });
  });

  it('keeps adminUrl() resolution when no target is given', () => {
    const options = governedProcessClientOptions({});
    expect(options).toEqual({ max: 2 });
    expect('url' in options).toBe(false);
  });
});
