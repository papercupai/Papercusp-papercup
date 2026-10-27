/**
 * Run independent filesystem work in bounded batches and consume each batch
 * before starting the next. Promise.all preserves input order, so callers can
 * publish results deterministically even when reads finish out of order.
 */
export const DOC_FILE_IO_BATCH_SIZE = 16;

export async function forEachBoundedBatch<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
  consume: (item: T, result: R) => void,
): Promise<void> {
  for (let offset = 0; offset < items.length; offset += DOC_FILE_IO_BATCH_SIZE) {
    const batch = items.slice(offset, offset + DOC_FILE_IO_BATCH_SIZE);
    const results = await Promise.all(batch.map(work));
    for (const [index, item] of batch.entries()) {
      consume(item, results[index]!);
    }
  }
}
