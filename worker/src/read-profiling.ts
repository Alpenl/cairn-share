// Request-local instrumentation. It never records SQL, bindings, object keys,
// response bodies or credential material. first/raw do not expose D1 metadata;
// report that uncertainty instead of treating their rows_read as zero.
export class ReadProfile {
  dbMilliseconds = 0;
  r2Milliseconds = 0;
  sqlCount = 0;
  dbRoundTrips = 0;
  r2Calls = 0;
  rowsRead = 0;
  rowsWritten = 0;
  unknownRows = 0;

  async db<T>(count: number, operation: () => Promise<T>): Promise<T> {
    this.sqlCount += count;
    this.dbRoundTrips++;
    const started = performance.now();
    try {
      const result = await operation();
      const results = Array.isArray(result) ? result : [result];
      let known = 0;
      for (const value of results) {
        const meta = value && typeof value === "object" && "meta" in value ? value.meta as D1Meta : null;
        if (meta && Number.isFinite(meta.rows_read)) {
          this.rowsRead += meta.rows_read;
          this.rowsWritten += meta.rows_written ?? 0;
          known++;
        }
      }
      this.unknownRows += Math.max(0, count - known);
      return result;
    } catch (cause) {
      this.unknownRows += count;
      throw cause;
    } finally { this.dbMilliseconds += performance.now() - started; }
  }

  async r2<T>(operation: () => Promise<T>): Promise<T> {
    this.r2Calls++;
    const started = performance.now();
    try { return await operation(); }
    finally { this.r2Milliseconds += performance.now() - started; }
  }
}

export function profileBindings<T extends { DB: D1Database; ENRICHMENT_IMAGES: R2Bucket }>(env: T, profile: ReadProfile): T {
  const unwrapped = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const statement = (raw: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(raw, { get(target, key) {
      if (key === "bind") return (...values: unknown[]) => statement(target.bind(...values));
      if (["first", "all", "run", "raw"].includes(String(key))) return (...args: unknown[]) =>
        profile.db(1, () => (Reflect.get(target, key) as (...values: unknown[]) => Promise<unknown>).apply(target, args));
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    unwrapped.set(wrapped, raw);
    return wrapped;
  };
  const DB = new Proxy(env.DB, { get(target, key) {
    if (key === "prepare") return (sql: string) => statement(target.prepare(sql));
    if (key === "batch") return (statements: D1PreparedStatement[]) =>
      profile.db(statements.length, () => target.batch(statements.map(s => unwrapped.get(s) ?? s)));
    if (key === "exec") return (sql: string) => profile.db(1, () => target.exec(sql));
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const ENRICHMENT_IMAGES = new Proxy(env.ENRICHMENT_IMAGES, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value === "function") return (...args: unknown[]) => profile.r2(() => value.apply(target, args));
    return value;
  } });
  return { ...env, DB, ENRICHMENT_IMAGES };
}
