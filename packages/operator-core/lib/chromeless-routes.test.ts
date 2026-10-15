import { describe, expect, it } from 'vitest';
import { isChromelessPath, isPortalEmbedLocation, routeHasSteeringSidebar } from './chromeless-routes';

describe('route presentation predicates', () => {
  it('keeps ordinary iframe routes chromeless', () => {
    expect(isChromelessPath('/pi')).toBe(true);
    expect(isChromelessPath('/project-docs/reference')).toBe(true);
    expect(isChromelessPath('/adv')).toBe(false);
    expect(isChromelessPath('/tasks-roster')).toBe(true);
    expect(isChromelessPath('/plans')).toBe(true);
    expect(isChromelessPath('/inbox')).toBe(true);
    // The portal's pane-only documents (owner ask 2026-09-01) carry no chrome:
    // each renders exactly one dock, and the OTHER dock must not mount around it.
    expect(isChromelessPath('/portal-panes/steering')).toBe(true);
    expect(isChromelessPath('/portal-panes/chat')).toBe(true);
  });

  it('recognises the portal embed query only on operator /adv routes', () => {
    expect(isPortalEmbedLocation('/adv', '?portalEmbed=1')).toBe(true);
    expect(isPortalEmbedLocation('/adv?tab=workflows', '?portalEmbed=true')).toBe(true);
    expect(isPortalEmbedLocation('/adv', '?portalEmbed=0')).toBe(false);
    expect(isPortalEmbedLocation('/settings', '?portalEmbed=1')).toBe(false);
    expect(isPortalEmbedLocation('/tasks-roster', '?portalEmbed=true')).toBe(true);
    expect(isPortalEmbedLocation('/plans', '?portalEmbed=1')).toBe(true);
    expect(isPortalEmbedLocation('/inbox', '?portalEmbed=yes')).toBe(true);
    expect(isPortalEmbedLocation('/plans', '')).toBe(false);
  });

  it('retains the steering sidebar on /adv while focused extracted routes stay bare', () => {
    expect(routeHasSteeringSidebar('/adv')).toBe(true);
    expect(routeHasSteeringSidebar('/adv/HUD')).toBe(true);
    expect(routeHasSteeringSidebar('/plans')).toBe(false);
    expect(routeHasSteeringSidebar('/inbox')).toBe(false);
    expect(routeHasSteeringSidebar('/tasks-roster')).toBe(false);
  });

  it('gives DAO Management the full page while preserving operations and other routes', () => {
    for (const path of ['/daos', '/daos/detail', '/dao', '/dao/review']) {
      expect(routeHasSteeringSidebar(path)).toBe(false);
      expect(isChromelessPath(path)).toBe(false);
    }
    for (const path of ['/adv', '/daos-other', '/dao-unrelated', '/settings']) {
      expect(routeHasSteeringSidebar(path)).toBe(true);
    }
  });

  it('drops the steering sidebar from a PORTAL-EMBEDDED /adv — the portal frames it as its own sidebar', () => {
    // Owner ask 2026-09-01: the Accounts rail and the Papercup chat are sidebars
    // of the outer cloud-portal page, framed from /portal-panes/*. An embedded
    // tab body that mounted the rail again would show it twice side by side.
    expect(routeHasSteeringSidebar('/adv', '?portalEmbed=1&tab=hud')).toBe(false);
    expect(routeHasSteeringSidebar('/adv', 'portalEmbed=true')).toBe(false);
    // Outside the portal the query contract is absent and the rail stays.
    expect(routeHasSteeringSidebar('/adv', '?tab=hud')).toBe(true);
    expect(routeHasSteeringSidebar('/adv', '?portalEmbed=0')).toBe(true);
    // The pane documents themselves are chromeless; the ROUTE mounts the dock.
    expect(routeHasSteeringSidebar('/portal-panes/steering', '?portalEmbed=1')).toBe(false);
  });
});
