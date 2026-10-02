// SQLite LIKE folds ASCII case only. Applying Unicode toLowerCase would lose
// candidates for non-ASCII case-sensitive text. Bigrams are candidates rather
// than matches: the unchanged per-field predicates decide the exact result.
export function searchGrams(terms: string[]): string[] {
  const grams = new Set<string>();
  for (const term of terms) {
    // SQLite LIKE terminates its pattern at NUL. Such a term cannot safely
    // require grams from the suffix; preserve the original predicate instead.
    if (term.includes("\0")) continue;
    const bytes = new TextEncoder().encode(term.replace(/[A-Z]/g, c => c.toLowerCase()));
    for (let i = 0; i + 1 < bytes.length; i++) grams.add(bytes[i].toString(16).padStart(2,"0").toUpperCase() + bytes[i+1].toString(16).padStart(2,"0").toUpperCase());
  }
  return [...grams];
}

export function indexedSearchCandidate(terms: string[]): { clause: string; binding: string } | null {
  const grams = searchGrams(terms);
  if (!grams.length) return null;
  return { clause: `links.id IN (SELECT link_id FROM bookmark_search_grams WHERE gram=(
    SELECT requested.value FROM json_each(?) requested LEFT JOIN bookmark_search_gram_counts frequency
      ON frequency.gram=requested.value ORDER BY COALESCE(frequency.link_count,0),requested.value LIMIT 1))`,
    binding: JSON.stringify(grams) };
}
