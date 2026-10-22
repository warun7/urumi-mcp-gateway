import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

// ajv-formats ships CJS; under ESM interop the function may sit on .default.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (a: Ajv) => void;

/**
 * Argument validation against the upstream's own inputSchema, BEFORE the call leaves the gateway.
 * Bad arguments become a readable tool error for the model instead of a round trip to the upstream.
 * strict:false because real-world servers ship slightly non-standard schemas.
 */
const ajv = new Ajv({ strict: false, allErrors: true, validateSchema: false, coerceTypes: false });
addFormats(ajv);

const cache = new Map<string, ValidateFunction>();
export const MAX_SCHEMA_BYTES = 64 * 1024;

export function compileSchema(key: string, schema: unknown): ValidateFunction {
  let fn = cache.get(key);
  if (!fn) {
    if (JSON.stringify(schema).length > MAX_SCHEMA_BYTES) throw new Error(`input schema larger than ${MAX_SCHEMA_BYTES} bytes`);
    fn = ajv.compile(schema as object);
    if (cache.size > 5000) cache.clear();
    cache.set(key, fn);
  }
  return fn;
}

export function validateArgs(key: string, schema: unknown, args: unknown): string | null {
  const fn = compileSchema(key, schema);
  if (fn(args)) return null;
  return (fn.errors ?? [])
    .slice(0, 5)
    .map((e) => `${e.instancePath || '(root)'} ${e.message}${e.params && 'allowedValues' in e.params ? `: ${(e.params.allowedValues as unknown[]).join(', ')}` : ''}`)
    .join('; ');
}
