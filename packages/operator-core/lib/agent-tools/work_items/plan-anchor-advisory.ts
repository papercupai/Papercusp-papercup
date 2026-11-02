/** Plan code links are a planning aid; differences never change completion authority. */
export function planAnchorAdvisory(payload: unknown, filesChanged: readonly string[] = []) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const anchors = (payload as Record<string, unknown>).anchors;
  if (!Array.isArray(anchors)) return undefined;
  const clean = (path: string) => path.trim().replace(/^\.\//, '');
  const planned = new Set(anchors.flatMap(anchor =>
    anchor && typeof anchor === 'object' && typeof anchor.path === 'string' && clean(anchor.path)
      ? [clean(anchor.path)] : []));
  if (planned.size === 0) return undefined;
  const changed = new Set(filesChanged.map(clean).filter(Boolean));
  const unplannedFiles = [...changed].filter(path => !planned.has(path)).sort();
  const untouchedFiles = [...planned].filter(path => !changed.has(path)).sort();
  if (unplannedFiles.length === 0 && untouchedFiles.length === 0) return undefined;
  return {
    unplannedFiles,
    untouchedFiles,
    message: [
      ...(unplannedFiles.length ? [`Changed outside the plan's code links: ${unplannedFiles.join(', ')}.`] : []),
      ...(untouchedFiles.length ? [`Linked files not reported changed: ${untouchedFiles.join(', ')}.`] : []),
      'This is advice; the completion is still recorded.',
    ].join(' '),
  };
}
