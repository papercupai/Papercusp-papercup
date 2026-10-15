// @vitest-environment jsdom
/**
 * FormField.test.tsx — whole-app-coverage P-008.
 *
 * The labelled form wrapper. Covers label + children passthrough, the required
 * asterisk, the optional description, and both error shapes (a plain string and
 * a react-hook-form FieldError) surfacing in a role="alert".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { FieldError } from 'react-hook-form';
import { FormField } from './FormField';

afterEach(cleanup);

describe('FormField', () => {
  it('associates the visible label with the supplied input id', () => {
    render(<FormField label="Display name" htmlFor="profile-name"><input id="profile-name" /></FormField>);
    expect(screen.getByLabelText('Display name').id).toBe('profile-name');
  });

  it('renders the label and its children', () => {
    render(
      <FormField label="Email">
        <input aria-label="email-input" />
      </FormField>,
    );
    expect(screen.getByText('Email')).toBeTruthy();
    expect(screen.getByLabelText('email-input')).toBeTruthy();
  });

  it('marks required fields with an asterisk', () => {
    render(<FormField label="Name" required><input /></FormField>);
    expect(screen.getByText('*')).toBeTruthy();
  });

  it('surfaces a string error in an alert', () => {
    render(<FormField label="Name" error="is required"><input /></FormField>);
    expect(screen.getByRole('alert').textContent).toBe('is required');
  });

  it('surfaces a react-hook-form FieldError message', () => {
    const err: FieldError = { type: 'required', message: 'too short' };
    render(<FormField label="Name" error={err}><input /></FormField>);
    expect(screen.getByRole('alert').textContent).toBe('too short');
  });

  it('renders no alert when there is no error', () => {
    render(<FormField label="Name"><input /></FormField>);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders an optional description', () => {
    render(<FormField label="Name" description="your full name"><input /></FormField>);
    expect(screen.getByText('your full name')).toBeTruthy();
  });
});
