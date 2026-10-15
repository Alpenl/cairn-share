// Tag catalog cache for the popup's tag cloud. The catalog is fetched once,
// kept in storage.local with its version, and later opens only compare the
// version. A newer library version is announced, never applied silently.
export const TAG_CACHE_KEY = "cairn_tags_v1";
export const PREFS_KEY = "cairn_prefs_v1";
export const DEFAULT_PREFS = { captureDefault: true, tagAutoCheck: true };

const refs = (dimensions = []) => new Set(dimensions.flatMap((d) => d.tags.map((t) => t.tag_ref)));
export const tagCount = (cache) => (cache?.dimensions || []).reduce((n, d) => n + d.tags.length, 0);

// mode "check": conditional request, keep the cached tags. mode "refresh":
// replace the cache. `result` is the API client's answer (null when the
// library has no tag endpoint). Returns the next cache and the refs that a
// refresh added, so the popup can mark them as new.
export function nextTagCache(cache, { binding, result, mode, now }) {
  const own = cache?.binding === binding ? cache : null;
  if (result === null) return { cache: { binding, unsupported: true, checkedAt: now }, added: [] };
  if (result.notModified) return { cache: { ...own, binding, checkedAt: now, update: null }, added: [] };
  const { catalog, etag } = result;
  if (mode === "check" && own?.dimensions) {
    if (catalog.catalog_version === own.version) return { cache: { ...own, checkedAt: now, update: null }, added: [] };
    const known = refs(own.dimensions);
    const added = [...refs(catalog.dimensions)].filter((ref) => !known.has(ref)).length;
    return { cache: { ...own, checkedAt: now, update: { version: catalog.catalog_version, added } }, added: [] };
  }
  const known = own?.dimensions ? refs(own.dimensions) : null;
  const dimensions = catalog.dimensions.filter((d) => d.tags.length);
  return {
    cache: { binding, version: catalog.catalog_version, etag, dimensions, syncedAt: now, checkedAt: now, update: null },
    added: known ? [...refs(dimensions)].filter((ref) => !known.has(ref)) : []
  };
}

export function createTagSync({ storage, controller, now = Date.now }) {
  const read = async () => (await storage.get(TAG_CACHE_KEY))[TAG_CACHE_KEY] ?? null;
  let running = null;
  let generation = 0;
  async function sync(mode) {
    // Popup and settings may both ask at once; share one request.
    if (running) return running;
    running = (async () => {
      const started = generation;
      const cache = await read();
      const { binding: current } = await controller.snapshot();
      const own = cache?.binding === current ? cache : null;
      const conditional = mode === "check" && own?.dimensions ? own.etag : undefined;
      const { binding, result } = await controller.tags(conditional);
      if (started !== generation || binding !== current || binding !== (await controller.snapshot()).binding) return { cache: null, added: [] };
      const next = nextTagCache(own, { binding, result, mode: own?.dimensions ? mode : "refresh", now: now() });
      await storage.set({ [TAG_CACHE_KEY]: next.cache });
      return next;
    })().finally(() => { running = null; });
    return running;
  }
  return { sync, clear: () => { generation++; return storage.remove(TAG_CACHE_KEY); } };
}

// Chip size steps relative to the most used tag in the current view.
export function tagSize(count, max) {
  if (max > 0 && count >= max * 0.7) return "s3";
  if (max > 0 && count >= max * 0.4) return "s2";
  return "s1";
}

// Short filter/legend labels: "资源类型" → "类型", "内容功能" → "功能".
export const shortLabel = (label) => ([...label].length > 3 ? [...label].slice(-2).join("") : label);
