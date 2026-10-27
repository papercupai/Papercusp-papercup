import PortalEntry from 'virtual:desktop-portal-entry';
import './DesktopPortalRoot.css';

/** Presentation only: the existing desktop root owns IPC, WSL and env/native controls. */
export default function DesktopPortalRoot() {
  return <div data-desktop-interface="portal-candidate" style={{
    height: 'calc(100dvh - var(--pc-env-bar-h, 0px))', minHeight: 0,
  }}><PortalEntry localMode /></div>;
}
