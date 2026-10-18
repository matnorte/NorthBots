/** Fetch bounded, ordered pages only as the consumer advances; never retain a workspace scan. */
export async function* scanRows<T extends { id: string | number }>(
  fetchPage: (after: T["id"] | undefined) => Promise<T[]>,
): AsyncGenerator<T> {
  let after: T["id"] | undefined;
  for (;;) {
    const rows = await fetchPage(after);
    if (!rows.length) return;
    yield* rows;
    after = rows[rows.length - 1]!.id;
  }
}

export async function* matching<T>(rows: AsyncIterable<T>, includes: (row: T) => boolean) {
  for await (const row of rows) if (includes(row)) yield row;
}

export async function* jsonArray(rows: AsyncIterable<unknown>) {
  yield "[";
  let first = true;
  for await (const row of rows) {
    yield `${first ? "" : ","}${JSON.stringify(row)}`;
    first = false;
  }
  yield "]";
}
