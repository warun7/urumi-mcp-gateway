/**
 * MCP tools carry full JSON Schema; LLM providers accept different subsets (Gemini's OpenAI-compatible
 * endpoint is the strictest). We inline local $refs and drop keywords providers commonly reject.
 */
const DROP = new Set(['$schema', '$id', '$comment', 'examples', 'default', 'format', 'pattern', 'patternProperties', 'propertyNames', 'unevaluatedProperties', 'dependentSchemas', 'if', 'then', 'else', 'contentEncoding', 'contentMediaType', 'readOnly', 'writeOnly', 'deprecated']);

export function toProviderSchema(schema: unknown): Record<string, unknown> {
  const root = (schema ?? {}) as Record<string, unknown>;
  const defs = { ...((root.$defs as object) ?? {}), ...((root.definitions as object) ?? {}) } as Record<string, unknown>;
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > 10) return {};
    if (Array.isArray(node)) return node.map((n) => walk(n, depth + 1));
    if (!node || typeof node !== 'object') return node;
    const o = node as Record<string, unknown>;
    if (typeof o.$ref === 'string') {
      const name = o.$ref.replace(/^#\/(\$defs|definitions)\//, '');
      return walk(defs[name] ?? {}, depth + 1);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (DROP.has(k) || k === '$defs' || k === 'definitions') continue;
      out[k] = k === 'properties' && v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, walk(pv, depth + 1)]))
        : walk(v, depth + 1);
    }
    return out;
  };
  const s = walk(root, 0) as Record<string, unknown>;
  if (s.type !== 'object') return { type: 'object', properties: {} };
  if (!s.properties) s.properties = {};
  return s;
}
