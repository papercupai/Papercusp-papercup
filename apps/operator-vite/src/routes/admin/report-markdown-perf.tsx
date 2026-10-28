import { useLayoutEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import type { ReportBlock } from '@papercusp/chat-protocol';
import { ReportBlockCard } from '@/app/_components/chat/ReportBlockCard';
import {
  beginInteraction,
  clearInteraction,
  endInteraction,
  PERF_INTERACTIONS,
} from '@/app/_components/perf/perf-marks';

const detail = 'The report keeps the original status, trust boundary, and evidence link available while rendering its formatted summary. '.repeat(8);
const report: ReportBlock = {
  title: 'Report markdown responsiveness fixture',
  plans: [{
    title: 'Representative report',
    status: 'active',
    items: Array.from({ length: 23 }, (_, index) => ({
      id: 'P-' + String(index + 1).padStart(3, '0'),
      status: 'wip' as const,
      text: [
        '**Report item ' + (index + 1) + '** — current status and owner-visible summary.',
        '',
        '- Evidence: record-' + (index + 1) + ' is retained with its source context.',
        '- Review: the result remains readable before and after the status refresh.',
        '',
        '| field | value |',
        '| --- | --- |',
        '| decision | preserve semantics |',
        '| context | ' + detail.trim() + ' |',
      ].join('\n'),
    })),
  }],
};

export const Route = createFileRoute('/admin/report-markdown-perf')({
  component: ReportMarkdownPerfPage,
});

function ReportMarkdownPerfPage() {
  const [visible, setVisible] = useState(false);

  useLayoutEffect(() => {
    if (visible) endInteraction(PERF_INTERACTIONS.reportMarkdownFirstMount);
  }, [visible]);

  const renderReport = () => {
    if (visible) return;
    clearInteraction(PERF_INTERACTIONS.reportMarkdownFirstMount);
    clearInteraction(PERF_INTERACTIONS.reportMarkdownInputDelay);
    beginInteraction(PERF_INTERACTIONS.reportMarkdownFirstMount);
    beginInteraction(PERF_INTERACTIONS.reportMarkdownInputDelay);
    window.setTimeout(() => {
      endInteraction(PERF_INTERACTIONS.reportMarkdownInputDelay);
    }, 0);
    setVisible(true);
  };

  return (
    <main data-testid="report-markdown-perf-page">
      <h1>Report markdown responsiveness</h1>
      <button type="button" data-testid="report-markdown-perf-trigger" onClick={renderReport}>
        Render report
      </button>
      <label>
        Input responsiveness probe
        <input data-testid="report-markdown-perf-input" />
      </label>
      {visible && (
        <section data-testid="report-markdown-perf-content">
          <ReportBlockCard report={report} harnessSlug="papercusp" />
        </section>
      )}
    </main>
  );
}
