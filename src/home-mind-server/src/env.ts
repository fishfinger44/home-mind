/**
 * Reading optional environment variables.
 *
 * Docker Compose writes an EMPTY STRING for a variable that was never set
 * (`FOO=${FOO:-}`), so `process.env.FOO ?? fallback` keeps the empty string and
 * the fallback never applies — which surfaces far from the cause, e.g. a request
 * to `/models/:generateContent` with no model in it, answered with a bare 404.
 */
export function envOrUndefined(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

/** Optional numeric env var; blank or unparseable falls back. */
export function envNumber(name: string, fallback: number): number {
  const raw = envOrUndefined(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
