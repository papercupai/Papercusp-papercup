/**
 * Fail closed when a CI task loses or changes the candidate run-group identity.
 * Local invocations remain compatible when no CI-owned group is expected.
 *
 * @param {{ required: boolean, expectedRunGroupId?: string, actualRunGroupId?: string, boundary: string }} input
 * @returns {Error|null}
 */
export function ciTestRunGroupGuardFailure({
  required,
  expectedRunGroupId,
  actualRunGroupId,
  boundary,
}) {
  if (!required) return null;
  if (typeof expectedRunGroupId !== 'string' || !expectedRunGroupId.trim()) {
    return Object.assign(new Error('ci-test-run-group-missing'), {
      code: 'AFFECTED_TEST_RUN_GROUP_GUARD',
    });
  }
  if (actualRunGroupId !== expectedRunGroupId) {
    return Object.assign(new Error('ci-test-run-group-changed-' + boundary), {
      code: 'AFFECTED_TEST_RUN_GROUP_GUARD',
    });
  }
  return null;
}
