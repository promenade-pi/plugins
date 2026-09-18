/** Shared attribute-type detection: values are always stored as text (see
 * `host/relational/schemas.ts`), so "is this numeric/boolean/datetime" is a
 * heuristic over the observed values — the same heuristic Attribute
 * Distribution and Attribute History both need, written once. */
export type AttributeKind = 'numeric' | 'boolean' | 'datetime' | 'categorical' | 'mixed';

export function detectAttributeKind(values: Array<string | null>): AttributeKind {
  const nonNull = values.filter((v): v is string => v != null && v !== '');
  if (nonNull.length === 0) return 'categorical';
  const isNum = (v: string) => v.trim() !== '' && Number.isFinite(Number(v));
  if (nonNull.every(isNum)) return 'numeric';
  if (nonNull.every((v) => ['true', 'false'].includes(v.toLowerCase()))) return 'boolean';
  if (nonNull.every((v) => /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v)))) return 'datetime';
  return nonNull.some(isNum) ? 'mixed' : 'categorical';
}
