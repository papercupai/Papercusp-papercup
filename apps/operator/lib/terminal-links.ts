import type { IDisposable, ILink, ILinkProvider, ITerminalAddon, Terminal } from '@xterm/xterm';
import { appRefs } from '@papercusp/operator-ui/papercup-chat/remark-work-refs';
import { navigateClient, shouldSoftNavigate } from '@papercusp/operator-core/lib/client-navigation';

type Position = ILink['range']['start'];
type Navigate = (href: string) => void;

function openAppReference(href: string): void {
  if (shouldSoftNavigate(href)) navigateClient(href);
}

/** Read the whole logical line, retaining the actual cells behind UTF-16 offsets.
 * Hard newlines stay separate. Wide-character continuation cells and trailing
 * null padding (including expanded cursor lines after resize) add no text.
 * Explicitly printed spaces and interior null cells remain separators. */
function readLogicalLine(terminal: Terminal, y: number) {
  const buffer = terminal.buffer.active;
  if (!Number.isInteger(y) || y < 1 || !buffer.getLine(y - 1)) return null;
  let first = y - 1;
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  let last = y - 1;
  while (buffer.getLine(last + 1)?.isWrapped) last++;
  let text = '';
  const starts: Position[] = [];
  const ends: Position[] = [];
  for (let row = first; row <= last; row++) {
    const line = buffer.getLine(row)!;
    let columns = Math.min(line.length, terminal.cols);
    while (columns > 0) {
      const tail = line.getCell(columns - 1)!;
      if (tail.getChars() || tail.getWidth() === 0) break;
      columns--;
    }
    for (let column = 0; column < columns; column++) {
      const cell = line.getCell(column)!;
      const width = cell.getWidth();
      if (width === 0) continue;
      const chars = cell.getChars();
      const value = chars || ' ';
      text += value;
      for (let offset = 0; offset < value.length; offset++) {
        starts.push({ x: column + 1, y: row + 1 });
        ends.push({ x: column + width, y: row + 1 });
      }
    }
  }
  return { text, starts, ends };
}

class AppReferenceProvider implements ILinkProvider, IDisposable {
  private disposed = false;
  constructor(private terminal: Terminal, private navigate: Navigate) {}

  provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void {
    const line = this.disposed ? null : readLogicalLine(this.terminal, y);
    if (!line) { callback(undefined); return; }
    const links: ILink[] = [];
    for (const match of appRefs(line.text)) {
      const start = line.starts[match.start];
      const end = line.ends[match.end - 1];
      if (!start || !end || y < start.y || y > end.y) continue;
      links.push({
        text: line.text.slice(match.start, match.end),
        range: { start, end },
        activate: (event) => {
          if (this.disposed) return;
          event.preventDefault();
          this.navigate(match.href);
        },
      });
    }
    callback(links);
  }

  dispose(): void { this.disposed = true; }
}

/** Xterm owns teardown. Its OSC 8 provider and existing WebLinksAddon retain
 * their handlers; this provider only recognizes shared, app-relative refs.
 * All xterm imports here are types, so hosts keep their SSR-safe lazy imports. */
export class TerminalLinksAddon implements ITerminalAddon {
  private provider?: AppReferenceProvider;
  private registration?: IDisposable;
  constructor(private navigate: Navigate = openAppReference) {}

  activate(terminal: Terminal): void {
    // Xterm replaces public dispose before calling activate. Calling that
    // wrapper here would remove this addon from its teardown manager.
    this.releaseRegistration();
    this.provider = new AppReferenceProvider(terminal, this.navigate);
    this.registration = terminal.registerLinkProvider(this.provider);
  }

  dispose(): void {
    this.releaseRegistration();
  }

  private releaseRegistration(): void {
    this.provider?.dispose();
    this.registration?.dispose();
    this.provider = undefined;
    this.registration = undefined;
  }
}
