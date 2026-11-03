/** The installed shell-quote package has no bundled TypeScript declarations. */
declare module 'shell-quote' {
  export function parse(source: string, env?: (name: string) => string):
    Array<string | { op: string } | { comment: string }>;
}
