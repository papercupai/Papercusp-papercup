import { useEffect, useRef, useState } from 'react';
import { Tooltip } from '@/app/harness/Tooltip';

/** GET /api/harness/:slug/community — provider-neutral (P-005, D-035). */
interface CommunityData {
  isShared: boolean;
  community: { providerId: string; displayName: string; presenceCount: number | null; name: string | null; inviteUrl: string | null } | null;
}

const POLL_MS = 5 * 60 * 1000;

/** The shared harness's community pill: live online count + invite, from whichever provider serves it. */
export default function CommunityBadge({ slug }: { slug: string | null }) {
  const [data, setData] = useState<CommunityData | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!slug) { setData(null); return; }
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/harness/${slug}/community`);
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as CommunityData;
        if (!cancelled) setData(json);
      } catch { /* network error — stay silent */ }
      if (!cancelled) timerRef.current = setTimeout(load, POLL_MS);
    }
    void load();
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [slug]);

  const community = data?.isShared ? data.community : null;
  if (!community?.inviteUrl) return null;
  const count = community.presenceCount;
  const label = community.name ?? community.displayName;

  return (
    <>
      <Tooltip label={count !== null ? `${count} online — join ${label}` : `Join ${label}`}>
        <a href={community.inviteUrl} target="_blank" rel="noopener noreferrer" className="pc-community-badge" data-provider={community.providerId}>
          {count !== null && <span className="pc-community-badge__dot" aria-hidden />}
          <span className="pc-community-badge__label">{count !== null ? `${count} online` : community.displayName}</span>
        </a>
      </Tooltip>
      <style>{`
        .pc-community-badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px;
          font-size: 11px; color: var(--fg-mute); text-decoration: none; border: 1px solid var(--border); white-space: nowrap; }
        .pc-community-badge:hover { color: var(--fg); border-color: var(--fg-mute); }
        .pc-community-badge__dot { width: 6px; height: 6px; border-radius: 50%; background: var(--good, #3ba55d); }
      `}</style>
    </>
  );
}
