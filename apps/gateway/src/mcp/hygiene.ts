import { createHash } from 'node:crypto';

/**
 * Tool-description hygiene ("tool poisoning" defence).
 * Upstream descriptions go straight into an LLM's context, so they are untrusted input.
 * We (1) strip invisible/control characters, (2) cap lengths, (3) flag suspicious patterns.
 * Flagged tools are quarantined (not visible) until an admin approves them.
 */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤﻿]|\u001B\[[0-9;]*[A-Za-z]/g;

export const MAX_DESCRIPTION = 1024;
export const MAX_PARAM_DESCRIPTION = 256;

export function clean(text: string | undefined, max: number): string {
  if (!text) return '';
  const t = text.replace(INVISIBLE, '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const SUSPICIOUS: [RegExp, string][] = [
  [/ignore (all |any )?(previous|prior|above) (instructions|prompts?)/i, 'prompt_override'],
  [/<\s*(important|system|instructions?)\s*>/i, 'hidden_instruction_tag'],
  [/do not (tell|inform|mention|show) (the )?user/i, 'concealment'],
  [/\b(api[_ -]?key|password|secret|token|private key|ssh|\.env|id_rsa)\b.*\b(send|include|pass|read|provide)\b|\b(send|include|pass|read|provide)\b.*\b(api[_ -]?key|password|secret|private key|id_rsa)\b/i, 'secret_exfiltration'],
  [/\b(before|instead of|after) (calling|using) (any|other|the) tools?\b/i, 'cross_tool_instruction'],
  [/https?:\/\/\S+/i, 'contains_url'],
];

/** Flags that quarantine a tool on first sight. Others (e.g. contains_url) are only shown to admins. */
export const QUARANTINE_FLAGS = new Set(['prompt_override', 'hidden_instruction_tag', 'concealment', 'secret_exfiltration', 'cross_tool_instruction', 'invisible_characters']);

export function scan(text: string): string[] {
  const flags = new Set<string>();
  for (const [re, flag] of SUSPICIOUS) if (re.test(text)) flags.add(flag);
  if (INVISIBLE.test(text)) flags.add('invisible_characters');
  INVISIBLE.lastIndex = 0;
  return [...flags];
}

/** Recursively clean parameter descriptions inside a JSON Schema and collect hygiene flags. */
export function cleanSchema(schema: unknown, flags: Set<string>, depth = 0): unknown {
  if (depth > 12) throw new Error('input schema nested too deeply');
  if (Array.isArray(schema)) return schema.map((s) => cleanSchema(s, flags, depth + 1));
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if ((k === 'description' || k === 'title') && typeof v === 'string') {
      scan(v).forEach((f) => flags.add(f));
      out[k] = clean(v, MAX_PARAM_DESCRIPTION);
    } else out[k] = cleanSchema(v, flags, depth + 1);
  }
  return out;
}

/** Stable JSON (sorted keys) so the hash doesn't change when an upstream reorders fields. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** Definition hash for rug-pull protection: any change to what the model sees changes the hash. */
export function defHash(t: { name: string; title?: string; description?: string; inputSchema: unknown; outputSchema?: unknown; annotations?: unknown }): string {
  return createHash('sha256')
    .update(stableStringify({ n: t.name, t: t.title ?? null, d: t.description ?? '', i: t.inputSchema, o: t.outputSchema ?? null, a: t.annotations ?? null }))
    .digest('hex');
}
