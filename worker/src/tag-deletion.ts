import type { Env } from './index';
import type { CatalogDimension } from './tag-catalog';
import { validateTaxonomy, type Taxonomy } from './taxonomy-v2';

export function deletedCollectionRules(env: Pick<Env, 'DB'>, refs: string[], stamp: string,
  guard: string, bindings: unknown[]): D1PreparedStatement[] {
  const aliases = JSON.stringify(refs);
  const affected = `EXISTS(SELECT 1 FROM json_each(rule_tags) WHERE value IN(SELECT value FROM json_each(?)))
    OR EXISTS(SELECT 1 FROM json_each(rule_exclude_tags) WHERE value IN(SELECT value FROM json_each(?)))`;
  return [
    env.DB.prepare(`DELETE FROM collection_rule_candidates WHERE status='pending' AND collection_id IN(
      SELECT id FROM collections WHERE ${affected}) AND ${guard}`).bind(aliases, aliases, ...bindings),
    env.DB.prepare(`UPDATE collections SET rule_enabled=0,
      rule_tags=(SELECT json_group_array(value) FROM json_each(rule_tags) WHERE value NOT IN(SELECT value FROM json_each(?))),
      rule_exclude_tags=(SELECT json_group_array(value) FROM json_each(rule_exclude_tags) WHERE value NOT IN(SELECT value FROM json_each(?))),
      rule_revision=rule_revision+1,revision=revision+1,updated_at=? WHERE (${affected}) AND ${guard}`)
      .bind(aliases, aliases, stamp, aliases, aliases, ...bindings),
  ];
}

/** Recheck at transaction admission, after asynchronous rule validation. */
export const currentRuleRefsSQL = `NOT EXISTS(SELECT 1 FROM json_each(?) r JOIN tag_catalog_operations d
  ON r.value IN('system/'||d.dimension||'/'||d.term_id,
    'system/'||CASE d.dimension WHEN 'forms' THEN 'form' WHEN 'uses' THEN 'use' ELSE d.dimension END||'/'||d.term_id)
  WHERE d.action='delete') AND NOT EXISTS(SELECT 1 FROM json_each(?) r JOIN custom_tag_operations d
  ON r.value='custom/default/'||d.tag_id WHERE d.action='delete')`;

/** Remove current definitions, never immutable source or classification history. */
export async function deleteCatalogTag(env: Pick<Env, 'DB'>,
  operation: { key: string; hash: string; dimension: CatalogDimension; id: string },
  current: { revision: number; catalog: Taxonomy }): Promise<string | null> {
  const { key, hash, dimension, id } = operation;
  const catalog = structuredClone(current.catalog);
  const before = catalog[dimension]!.find(t => t.id === id)!;
  catalog[dimension] = catalog[dimension]!.filter(t => t.id !== id).map(t => ({ ...t,
    ...(t.relations?.some(r => r.id === id) ? { relations: t.relations.filter(r => r.id !== id) } : {}) }));
  if (!catalog[dimension]!.some(t => t.active && !t.deprecated && t.ai_enabled !== false &&
    !(dimension === 'uses' && t.id === 'contra'))) return 'last_ai_tag';
  if (validateTaxonomy(catalog).length) return 'invalid_tag_definition';
  catalog.version = `managed-${crypto.randomUUID()}`;
  catalog.definition_version++;
  const next = current.revision + 1, stamp = new Date().toISOString(), admission = crypto.randomUUID();
  const field = dimension === 'forms' ? 'form' : dimension === 'uses' ? 'use' : dimension;
  const tagRef = `system/${field}/${id}`;
  // The collection contract also accepts plural aliases. Remove both spellings.
  const aliases = JSON.stringify([tagRef, `system/${dimension}/${id}`]);
  const affectedRule = `EXISTS(SELECT 1 FROM json_each(rule_tags) WHERE value IN(SELECT value FROM json_each(?)))
    OR EXISTS(SELECT 1 FROM json_each(rule_exclude_tags) WHERE value IN(SELECT value FROM json_each(?)))`;
  const guard = 'EXISTS(SELECT 1 FROM tag_catalog_state WHERE id=1 AND revision=? AND last_operation=?)';
  const g = [next, admission];
  await env.DB.batch([
    env.DB.prepare(`UPDATE tag_catalog_state SET revision=?,version=?,last_operation=? WHERE id=1 AND revision=?
      AND NOT EXISTS(SELECT 1 FROM tag_catalog_operations WHERE operation_key=?)`)
      .bind(next, catalog.version, admission, current.revision, key),
    env.DB.prepare(`INSERT INTO tag_catalog_snapshots(revision,version,catalog,created_at) SELECT ?,?,?,? WHERE ${guard}`)
      .bind(next, catalog.version, JSON.stringify(catalog), stamp, ...g),
    // The receipt is also the permanent deletion policy; retain pre-delete rules
    // for audit and recovery. Do not silently broaden a collection's predicate.
    env.DB.prepare(`INSERT INTO tag_catalog_operations(operation_key,request_hash,revision,dimension,term_id,action,before_value,after_value,created_at)
      SELECT ?,?,?,?,?,'delete',?,json_object('deleted',json('true'),'rules_before',json((
        SELECT json_group_array(json_object('id',id,'revision',revision,'rule_revision',rule_revision,
          'enabled',rule_enabled,'tags',json(rule_tags),'exclude_tags',json(rule_exclude_tags)))
        FROM collections WHERE ${affectedRule}))),? WHERE ${guard}`)
      .bind(key, hash, next, dimension, id, JSON.stringify(before), aliases, aliases, stamp, ...g),
    env.DB.prepare(`INSERT INTO tag_change_facts(link_id,operation_key,operation_id,field,term,action,source,revision,context,created_at)
      SELECT l.id,?||':'||l.id,?,?,?,'reject','human',l.personal_revision+1,?,? FROM links l
      JOIN effective_tag_memberships m ON m.link_id=l.id AND m.field=? AND m.term=? WHERE ${guard}`)
      .bind(key, key, field, id, JSON.stringify({ definition_operation: key, deleted: true }), stamp, field, id, ...g),
    env.DB.prepare(`UPDATE links SET personal_revision=personal_revision+1 WHERE id IN(
      SELECT link_id FROM effective_tag_memberships WHERE field=? AND term=?) AND ${guard}`).bind(field, id, ...g),
    env.DB.prepare(`DELETE FROM effective_tag_memberships WHERE field=? AND term=? AND ${guard}`).bind(field, id, ...g),
    ...deletedCollectionRules(env, [tagRef, `system/${dimension}/${id}`], stamp, guard, g),
    env.DB.prepare(`DELETE FROM taxonomy_display_overrides WHERE dimension=? AND term_id=? AND ${guard}`).bind(dimension, id, ...g),
    env.DB.prepare(`INSERT INTO cache_metadata(key,value,updated_at) SELECT 'links_generation',1,? WHERE ${guard}
      ON CONFLICT(key) DO UPDATE SET value=value+1,updated_at=excluded.updated_at`).bind(stamp, ...g),
  ]);
  return null;
}
