declare const __PAPERCUSP_DESKTOP_PORTAL__: boolean;

declare module 'virtual:desktop-portal-entry' {
  const PortalEntry: import('react').ComponentType<{ localMode?: boolean }>;
  export default PortalEntry;
}
