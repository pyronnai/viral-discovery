import { z } from 'zod';

/**
 * A list-valued query parameter. Accepts an array or a comma-separated string, so
 * the same SourceQuery.params work from JSON config and from CLI flags.
 */
export function stringList<T extends z.ZodType<string>>(item: T) {
  return z.preprocess((value) => {
    const items: unknown = typeof value === 'string' ? value.split(',') : value;
    if (!Array.isArray(items)) return items;
    return items
      .map((s: unknown) => (typeof s === 'string' ? s.trim() : s))
      .filter((s) => s !== '');
  }, z.array(item));
}

/** Parses adapter params, throwing an Error whose message names each bad parameter. */
export function parseParams<T extends z.ZodType>(
  adapterId: string,
  schema: T,
  params: unknown,
): z.infer<T> {
  const result = schema.safeParse(params);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || 'params'}: ${i.message}`)
      .join('; ');
    throw new InvalidParamsError(adapterId, issues);
  }
  return result.data;
}

export class InvalidParamsError extends Error {
  constructor(adapterId: string, issues: string) {
    super(`invalid ${adapterId} query parameters: ${issues}`);
    this.name = 'InvalidParamsError';
  }
}
