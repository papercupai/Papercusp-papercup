"use client";

import {
  createContext,
  useContext,
  type ReactNode,
} from "react";

/**
 * Host-owned controls that belong inside one of the operator's canonical
 * Settings pages.
 *
 * A host may have settings the desktop operator does not own (for example the
 * web portal's persisted light/system/dark preference). Those controls still
 * belong in the Settings information architecture, not in a second host-level
 * card above it. These slots let the host supply the control while the
 * operator page keeps ownership of its location and surrounding hierarchy.
 */
export type OperatorSettingsSlotName =
  | "personalization"
  // Replaces desktop identity/project-directory effects for hosted accounts.
  | "profile"
  // Replaces the native picker and its theme-writing hooks. A host theme
  // must have one owner even when the canonical Settings page is mounted.
  | "theme"
  // Hosted profiles cannot use the desktop's saved-prompt API. A replacement
  // keeps that component and its fetch effects unmounted.
  | "saved-prompts"
  | "papercup-agent";

export type OperatorSettingsSlots = Partial<
  Record<OperatorSettingsSlotName, ReactNode>
>;

const OperatorSettingsSlotsContext =
  createContext<OperatorSettingsSlots>({});

export function OperatorSettingsSlotsProvider({
  slots,
  children,
}: {
  slots: OperatorSettingsSlots;
  children: ReactNode;
}) {
  return (
    <OperatorSettingsSlotsContext.Provider value={slots}>
      {children}
    </OperatorSettingsSlotsContext.Provider>
  );
}

/** Render a host control or an inert native fallback at its canonical location. */
export function OperatorSettingsSlot({
  name,
  fallback = null,
}: {
  name: OperatorSettingsSlotName;
  fallback?: ReactNode;
}) {
  return useContext(OperatorSettingsSlotsContext)[name] ?? fallback;
}
