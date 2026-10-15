/**
 * Recover the target-argument record carried through `tools:invoke`.
 *
 * Some MCP clients serialize that one nested boundary before transport, and
 * deeply nested payloads have been observed with more than one encoding layer.
 * Keep this decoder shared by the transport's reserved-argument forwarders and
 * the tool's schema preprocessing so both stages interpret the same wire shape.
 * Only the wrapper value is decoded; strings inside the target args are never
 * inspected.
 */
function recoverRecordWithSurplusClosingBrace(value: string): Record<string, unknown> | undefined {
  // Two reported long calls arrived as a JSON record string followed by one
  // redundant closing brace. Strict parsing failed only at that final byte;
  // removing exactly that byte recovered the intended record. Keep this
  // compatibility repair narrow: arrays, primitives, and other malformed
  // strings still fail the record schema.
  if (!value.endsWith('}}')) return undefined;
  try {
    const parsed: unknown = JSON.parse(value.slice(0, -1));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the original string so the record validator rejects it.
  }
  return undefined;
}

export function decodeToolsInvokeArgs(value: unknown): unknown {
  let current = value;
  for (let i = 0; i < 5 && typeof current === 'string'; i += 1) {
    const text = current;
    try {
      current = JSON.parse(text);
    } catch {
      const recovered = recoverRecordWithSurplusClosingBrace(text);
      if (recovered) {
        current = recovered;
        continue;
      }
      break;
    }
  }
  return current;
}
