/** @vitest-environment jsdom */
/**
 * PapercupChat — the D-005 trust matrix, asserted on the RENDERED DOM
 * (papercup-chat-one-component-one-contract-2026-09-06 P-007). One case per
 * `md-*` row of PARITY.md whose public/owner trust differs from plain render:
 *
 *   md-html / md-html-comment   inert on both hosts
 *   md-unsafe-url               inert on both hosts (javascript:, data:, unlisted relative)
 *   md-links                    allowlist (https/http/mailto and canonical /docs hrefs)
 *   md-images                   off on public, opt-in on owner
 *   md-tables                   inert on public, render on owner
 *   md-work-refs                inert on public, pill on owner
 *
 * plus a smoke render of the whole view over a fake controller.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardPresentation, ChatTurn, OpenCardSnapshot, ReportBlock } from '@papercusp/chat-protocol';
import { ChatMarkdown, PapercupChat, askTranscriptPlaceholder, lookedAtTools, papercupChatUrlTransform } from './PapercupChat';
import type { PapercupChatController } from './use-papercup-chat';

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: [], loading: false, error: null }),
}));

// Vitest exposes no global afterEach, so RTL's auto-cleanup never registers;
// without this every render stacks on the previous one.
afterEach(cleanup);

function md(content: string, hostTrust: 'owner' | 'public', extra: Partial<Parameters<typeof ChatMarkdown>[0]> = {}) {
  return render(<ChatMarkdown content={content} hostTrust={hostTrust} harnessSlug="papercusp" {...extra} />).container;
}

describe('papercupChatUrlTransform (md-links / md-unsafe-url)', () => {
  it('passes only http/https/mailto absolute URLs', () => {
    expect(papercupChatUrlTransform('https://example.com/x?y=1')).toBe('https://example.com/x?y=1');
    expect(papercupChatUrlTransform('http://127.0.0.1:3055/plans')).toBe('http://127.0.0.1:3055/plans');
    expect(papercupChatUrlTransform('mailto:a@b.c')).toBe('mailto:a@b.c');
    // eslint-disable-next-line no-script-url
    expect(papercupChatUrlTransform('javascript:alert(1)')).toBe('');
    expect(papercupChatUrlTransform('data:text/html,<b>x</b>')).toBe('');
    expect(papercupChatUrlTransform('vbscript:x')).toBe('');
    expect(papercupChatUrlTransform('/settings')).toBe('');
    expect(papercupChatUrlTransform('#anchor')).toBe('');
    expect(papercupChatUrlTransform('')).toBe('');
  });

  it('allows canonical public Docs hrefs while rejecting host-relative escapes and image sources', () => {
    for (const url of ['/docs', '/docs/', '/docs/faq#does-closing-the-browser-stop-my-agents', '/docs/getting-started/cloud/']) {
      expect(papercupChatUrlTransform(url, 'href')).toBe(url);
      expect(papercupChatUrlTransform(url, 'src')).toBe('');
    }
    for (const url of ['/settings', '/docs-old', '//evil.example/docs/faq', '/docs/../settings',
      '/docs/./faq', '/docs/%2e%2e/settings', '/docs/%2f%2fevil.example', '/docs/faq?token=secret',
      '/docs\\evil', '/docs/faq\n/settings', '/docs/faq#javascript:alert(1)', '/docs//faq']) {
      expect(papercupChatUrlTransform(url, 'href')).toBe('');
    }
  });
});

describe('ChatMarkdown — D-005 on both hosts', () => {
  for (const host of ['public', 'owner'] as const) {
    describe(`hostTrust=${host}`, () => {
      it('renders emphasis, inline code, lists, headings, code blocks, blockquotes', () => {
        const c = md('# Title\n\n**bold** and `code`\n\n- one\n- two\n\n> quoted\n\n```\nblock\n```', host);
        expect(c.querySelector('h1')?.textContent).toBe('Title');
        expect(c.querySelector('strong')?.textContent).toBe('bold');
        expect(c.querySelector('code')?.textContent).toBe('code');
        expect(c.querySelectorAll('li')).toHaveLength(2);
        expect(c.querySelector('blockquote')?.textContent).toContain('quoted');
        expect(c.querySelector('pre code')?.textContent).toContain('block');
      });

      it('renders GFM strikethrough and task lists', () => {
        const c = md('~~gone~~\n\n- [x] done\n- [ ] open', host);
        expect(c.querySelector('del')?.textContent).toBe('gone');
        const boxes = c.querySelectorAll('input[type="checkbox"]');
        expect(boxes).toHaveLength(2);
        expect((boxes[0] as HTMLInputElement).checked).toBe(true);
      });

      it('raw HTML and HTML comments are INERT text, never elements (md-html, md-html-comment)', () => {
        const c = md('before <script>alert(1)</script> <b onclick="x()">bold?</b> <!-- hidden --> after', host);
        expect(c.querySelector('script')).toBeNull();
        expect(c.querySelector('b')).toBeNull();
        expect(c.querySelector('[onclick]')).toBeNull();
        expect(c.textContent).toContain('<script>alert(1)</script>');
        expect(c.textContent).toContain('<!-- hidden -->');
      });

      it('an https link renders as a new-tab link; javascript:/data:/relative links are inert text', () => {
        const c = md(
          '[ok](https://example.com) [mail](mailto:a@b.c) [js](javascript:alert(1)) [data](data:text/html,x) [rel](/settings)',
          host,
        );
        const links = [...c.querySelectorAll('a')];
        expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com', 'mailto:a@b.c']);
        for (const a of links) {
          expect(a.getAttribute('target')).toBe('_blank');
          expect(a.getAttribute('rel')).toContain('noopener');
        }
        const inert = [...c.querySelectorAll('.pc-chat__link-inert')].map((s) => s.textContent);
        expect(inert).toEqual(['js', 'data', 'rel']);
        expect(c.querySelector('a[href^="javascript"]')).toBeNull();
      });

      it('keeps the actual public FAQ citation clickable without widening other relative links or image sources', () => {
        const citation = '/docs/faq#does-closing-the-browser-stop-my-agents';
        const c = md(
          `Closing the tab won’t stop remote work. [Public FAQ](${citation}) `
            + '[manual](/docs) [nested](/docs/getting-started/cloud/) '
            + '[settings](/settings) [escape](/docs/../settings) '
            + '[encoded](/docs/%2e%2e/settings) [authority](//evil.example/docs/faq) '
            + '![relative image](/docs/faq)',
          host, { allowImages: true },
        );
        const links = [...c.querySelectorAll('a')];
        expect(links.map(a => a.getAttribute('href'))).toEqual([citation, '/docs', '/docs/getting-started/cloud/']);
        expect(links[0].textContent).toBe('Public FAQ');
        for (const link of links) {
          expect(link.getAttribute('target')).toBe('_blank');
          expect(link.getAttribute('rel')).toContain('noopener');
        }
        expect([...c.querySelectorAll('.pc-chat__link-inert')].map(e => e.textContent))
          .toEqual(['settings', 'escape', 'encoded', 'authority']);
        expect(c.querySelector('img')).toBeNull();
        expect(c.querySelector('.pc-chat__img-inert')?.textContent).toBe('[image: relative image]');
      });

      it('an image is off unless the OWNER opts in (md-images)', () => {
        const off = md('![alt text](https://example.com/a.png)', host);
        expect(off.querySelector('img')).toBeNull();
        expect(off.querySelector('.pc-chat__img-inert')?.textContent).toBe('[image: alt text]');

        const optIn = md('![alt text](https://example.com/a.png) ![bad](javascript:x)', host, { allowImages: true });
        if (host === 'owner') {
          const imgs = optIn.querySelectorAll('img');
          expect(imgs).toHaveLength(1);
          expect(imgs[0].getAttribute('src')).toBe('https://example.com/a.png');
          expect(imgs[0].getAttribute('referrerpolicy')).toBe('no-referrer');
          // The disallowed scheme stays inert even with images on.
          expect(optIn.querySelectorAll('.pc-chat__img-inert')).toHaveLength(1);
        } else {
          expect(optIn.querySelector('img')).toBeNull();
          expect(optIn.querySelectorAll('.pc-chat__img-inert')).toHaveLength(2);
        }
      });
    });
  }

  const TABLE = 'Intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nOutro';

  it('a GFM table renders on the owner host (md-tables owner=render)', () => {
    const c = md(TABLE, 'owner');
    expect(c.querySelector('table')).not.toBeNull();
    expect(c.querySelectorAll('td')).toHaveLength(2);
  });

  it('a GFM table is shown as its source text on the public host (md-tables public=inert)', () => {
    const c = md(TABLE, 'public');
    expect(c.querySelector('table')).toBeNull();
    const inert = c.querySelector('.pc-chat__table-inert');
    expect(inert?.textContent).toContain('| a | b |');
    expect(inert?.textContent).toContain('| 1 | 2 |');
    expect(c.textContent).toContain('Intro');
    expect(c.textContent).toContain('Outro');
  });

  it('a work ref is a pill on the owner host and plain text on the public host (md-work-refs)', () => {
    const owner = md('See WI-4321 and `WI-9999` please', 'owner');
    const pill = owner.querySelector('[data-ref-kind="work-item"]');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe('WI-4321');
    // Inside a code span it is never a pill.
    expect(owner.querySelector('code')?.textContent).toBe('WI-9999');

    const pub = md('See WI-4321 please', 'public');
    expect(pub.querySelector('[data-ref-kind]')).toBeNull();
    expect(pub.textContent).toContain('WI-4321');
  });

  it('a single newline is a hard break', () => {
    const c = md('line one\nline two', 'owner');
    expect(c.querySelectorAll('br')).toHaveLength(1);
  });
});

describe('pure view helpers', () => {
  it('askTranscriptPlaceholder distinguishes an empty conversation from one still opening', () => {
    expect(askTranscriptPlaceholder({ turnCount: 0, hasLiveTurn: false, hasSurfaceError: false, busy: false })).toBe('invite');
    expect(askTranscriptPlaceholder({ turnCount: 0, hasLiveTurn: false, hasSurfaceError: false, busy: true })).toBe('opening');
    expect(askTranscriptPlaceholder({ turnCount: 1, hasLiveTurn: false, hasSurfaceError: false, busy: true })).toBeNull();
    expect(askTranscriptPlaceholder({ turnCount: 0, hasLiveTurn: true, hasSurfaceError: false, busy: false })).toBeNull();
    expect(askTranscriptPlaceholder({ turnCount: 0, hasLiveTurn: false, hasSurfaceError: true, busy: false })).toBeNull();
  });
  it('lookedAtTools collapses consecutive repeats and hides the card tool', () => {
    expect(
      lookedAtTools([{ name: 'work_items:get' }, { name: 'work_items:get' }, { name: 'chat:ask_choice' }, { name: 'plans:get' }, { name: 'work_items:get' }]),
    ).toEqual(['work_items:get', 'plans:get', 'work_items:get']);
  });
});

function controller(overrides: Partial<PapercupChatController> = {}): PapercupChatController {
  return {
    conversationId: 'conv-1',
    turns: [],
    live: null,
    streaming: false,
    busy: false,
    loadingHistory: false,
    hasMoreEarlier: false,
    pendingCards: [],
    cardBusy: false,
    cardError: null,
    surfaceError: null,
    unsentQuestion: '',
    retryTarget: null,
    send: vi.fn(async () => {}),
    answerCard: vi.fn(async () => {}),
    answerPersistedCard: null,
    retry: vi.fn(async () => {}),
    loadEarlier: vi.fn(async () => {}),
    abort: vi.fn(),
    appendLocalTurns: vi.fn(),
    ...overrides,
  };
}

describe('PapercupChat — the view over a controller', () => {
  // jsdom lays nothing out: the scroller measures 0×0, and @tanstack/virtual
  // renders NO rows for a 0-height viewport (its range is null until
  // outerSize > 0). It reads the viewport through offsetWidth/offsetHeight and
  // each row through getBoundingClientRect — give both a box so the transcript
  // materialises.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 800,
      height: 600,
      top: 0,
      left: 0,
      bottom: 600,
      right: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const turns: ChatTurn[] = [
    { id: 'u1', role: 'user', text: 'hello?', createdAt: Date.now() - 60_000 },
    {
      id: 'a1',
      role: 'assistant',
      text: 'Hi **there**',
      createdAt: Date.now() - 30_000,
      tools: [{ name: 'work_items:get', input: { id: 'WI-1' } }, { name: 'work_items:get' }],
      provenance: { engine: 'loop', model: 'claude-sonnet-5' },
    },
  ];

  const report: ReportBlock = {
    title: 'Fleet update',
    plans: [
      {
        slug: 'report-renderer-regression',
        title: 'Renderer regression',
        status: 'active',
        items: [{ id: 'P-001', status: 'done', text: '**Escalation** resolved in WI-4321' }],
      },
    ],
  };

  it.each(['owner', 'public'] as const)(
    'the default report renderer preserves markdown and applies %s work-ref trust without a host override',
    (hostTrust) => {
      const reportTurn: ChatTurn = {
        id: `report-${hostTrust}`,
        role: 'assistant',
        text: '',
        createdAt: Date.now(),
        report,
      };

      render(<PapercupChat chat={controller({ turns: [reportTurn] })} hostTrust={hostTrust} harnessSlug="papercusp" />);

      const card = screen.getByRole('group', { name: 'Fleet update' });
      expect(card.querySelector('strong')?.textContent).toBe('Escalation');
      expect(card.querySelector('.report-block-item-text')?.textContent).toContain('resolved in WI-4321');
      expect(card.querySelector('.report-block-item-text')?.tagName).toBe('SPAN');
      if (hostTrust === 'owner') {
        expect(card.querySelector('[data-ref-kind="work-item"]')?.textContent).toBe('WI-4321');
      } else {
        expect(card.querySelector('[data-ref-kind]')).toBeNull();
      }
    },
  );

  it('public host: shows the capability notice, the transcript, provenance and the Looked at line', () => {
    const chat = controller({ turns });
    render(<PapercupChat chat={chat} hostTrust="public" />);
    const root = screen.getByTestId('papercup-chat');
    expect(root.getAttribute('data-host-trust')).toBe('public');
    expect(root.getAttribute('data-state')).toBe('idle');
    expect(screen.getByRole('note').textContent).toMatch(/full access to this machine/);
    expect(within(root).getByText('hello?')).toBeTruthy();
    expect(root.querySelector('strong')?.textContent).toBe('there');
    expect(within(root).getByText(/Looked at: work_items:get$/)).toBeTruthy();
    expect(within(root).getByText(/Answered by loop · claude-sonnet-5/)).toBeTruthy();
    const stamps = [...root.querySelectorAll('[data-testid="chat-message-time"]')];
    expect(stamps).toHaveLength(2);
    expect(stamps.every((stamp) => /^\d{2}:\d{2}$/.test(stamp.textContent ?? ''))).toBe(true);
    expect(stamps.every((stamp) => stamp.parentElement?.classList.contains('pc-chat__message-line'))).toBe(true);
    expect(root.querySelector('.pc-chat__turn-meta')).toBeNull();
    expect(root.querySelector('.pc-chat__role[data-role="assistant"]')?.classList.contains('pc-chat__sr-only')).toBe(true);
    expect(within(root).queryByText('Ask a question to start.')).toBeNull();
  });

  it('owner host: no notice by default; the composer sends the trimmed draft and clears it', () => {
    const chat = controller();
    render(<PapercupChat chat={chat} hostTrust="owner" />);
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByText('Ask a question to start.')).toBeTruthy();
    const input = screen.getByLabelText('Message Papercup') as HTMLTextAreaElement;
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '  ship it  ' } });
    expect(send.disabled).toBe(false);
    fireEvent.submit(send.form as HTMLFormElement);
    expect(chat.send).toHaveBeenCalledWith('ship it');
    expect(input.value).toBe('');
  });

  it('streaming: the live row, the Stop button, and data-state', () => {
    const chat = controller({
      turns,
      streaming: true,
      live: { text: 'Think', toolCalls: [], provenance: null, errorCode: null, errorMessage: null, retryAfterMs: null, cards: [], done: false },
    });
    render(<PapercupChat chat={chat} hostTrust="owner" />);
    const root = screen.getByTestId('papercup-chat');
    expect(root.getAttribute('data-state')).toBe('streaming');
    expect(root.querySelector('[data-turn="live"]')?.textContent).toContain('Think');
    screen.getByRole('button', { name: 'Stop' }).click();
    expect(chat.abort).toHaveBeenCalled();
  });

  it('a surface error renders the taxonomy sentence and a retry that calls back', () => {
    const chat = controller({
      surfaceError: { code: 'portal_operator_status_503', context: 'conversation', retryAfterMs: null },
      retryTarget: 'conversation',
    });
    render(<PapercupChat chat={chat} hostTrust="public" />);
    const root = screen.getByTestId('papercup-chat');
    expect(root.getAttribute('data-state')).toBe('operator-down');
    expect(screen.getByRole('alert').textContent).toMatch(/not reachable/);
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(chat.retry).toHaveBeenCalled();
  });

  it('open cards render through the shared PendingCardsBar and answer through the controller', () => {
    const chat = controller({
      pendingCards: [
        {
          correlationId: 'c-1',
          prompt: 'Which one?',
          createdAt: Date.now(),
          presentation: { kind: 'radio', options: [{ id: 'a', label: 'Option A' }] },
        } as PapercupChatController['pendingCards'][number],
      ],
    });
    render(<PapercupChat chat={chat} hostTrust="owner" />);
    expect(screen.getByText('Which one?')).toBeTruthy();
    screen.getByText('Option A').click();
    expect(chat.answerCard).toHaveBeenCalledWith(expect.objectContaining({ action: 'submit', correlationId: 'c-1' }));
  });

  const cardPresentations: Array<[string, CardPresentation]> = [
    ['radio', { kind: 'radio', options: [{ id: 'a', label: 'A' }] }],
    ['checkbox', { kind: 'checkbox', options: [{ id: 'a', label: 'A' }] }],
    ['select', { kind: 'select', options: [{ id: 'a', label: 'A' }] }],
    ['text', { kind: 'text', placeholder: 'Type here' }],
    ['date', { kind: 'date', min: '2026-01-01', max: '2026-12-31' }],
    ['slider', { kind: 'slider', min: 0, max: 10, step: 1 }],
  ];

  it.each(cardPresentations)('renders the %s state-card kind through the one shared tail', (kind, presentation) => {
    const card: OpenCardSnapshot = {
      correlationId: `card-${kind}`,
      prompt: `${kind} question`,
      createdAt: Date.now(),
      presentation,
    };
    render(<PapercupChat chat={controller({ pendingCards: [card] })} hostTrust="owner" />);
    expect(screen.getByText(`${kind} question`)).toBeTruthy();
  });

  it.each(['owner', 'public'] as const)('restores a persisted card and routes its answer with the owning turn identity on %s', (hostTrust) => {
    const answerPersistedCard = vi.fn(async () => {});
    const turn: ChatTurn = {
      id: 'persisted-card-turn',
      seq: 42,
      role: 'assistant',
      text: '',
      createdAt: Date.now(),
      tools: [
        {
          name: 'chat:ask_choice',
          input: { question: 'Persisted question?', options: JSON.stringify([{ id: 'a', label: 'Persisted A' }]) },
        },
      ],
    };
    render(<PapercupChat chat={controller({ turns: [turn], answerPersistedCard })} hostTrust={hostTrust} />);
    screen.getByText('Persisted A').click();
    expect(answerPersistedCard).toHaveBeenCalledWith({
      turn,
      toolIndex: 0,
      picks: [{ option_id: 'a', label: 'Persisted A' }],
    });
  });

  it('keeps a saved public card inert when the host supplies no answer capability', () => {
    const turn: ChatTurn = {
      id: 'read-only-card', seq: 42, role: 'assistant', text: '', createdAt: Date.now(),
      tools: [{ name: 'chat:ask_choice', input: {
        question: 'Read-only question?', options: [{ id: 'a', label: 'Unavailable choice' }],
      } }],
    };
    render(<PapercupChat chat={controller({ turns: [turn], answerPersistedCard: null })} hostTrust="public" />);
    expect(screen.getByText('Read-only question?')).toBeTruthy();
    expect(screen.queryByText('Unavailable choice')).toBeNull();
  });

  it('renders a persisted declined card as settled history, not an answerable duplicate', () => {
    const answerPersistedCard = vi.fn(async () => {});
    const turn: ChatTurn = {
      id: 'declined-card-turn',
      seq: 43,
      role: 'assistant',
      text: '',
      createdAt: Date.now(),
      tools: [
        {
          name: 'chat:ask_choice',
          input: { question: 'Old question?', options: [{ id: 'a', label: 'Old A' }] },
          answered: { picks: [], declined: true, at: Date.now() - 1_000 },
        },
      ],
    };
    render(<PapercupChat chat={controller({ turns: [turn], answerPersistedCard })} hostTrust="owner" />);
    expect(screen.getByText('Old question?')).toBeTruthy();
    expect(answerPersistedCard).not.toHaveBeenCalled();
  });

  it('host slots: the action bar and composer chrome render where the IR puts them', () => {
    const chat = controller({ turns });
    render(
      <PapercupChat
        chat={chat}
        hostTrust="owner"
        renderActionBar={(turn) => <button type="button">act-{turn.id}</button>}
        composerChrome={<span data-testid="chrome">🎤</span>}
      />,
    );
    expect(screen.getByText('act-a1')).toBeTruthy();
    expect(screen.getByTestId('chrome').closest('form')).not.toBeNull();
  });
});
