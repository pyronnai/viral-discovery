const ISO_DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/**
 * Parses the ISO 8601 durations the API returns in contentDetails.duration
 * ("PT15M33S", "PT1H2M", "P1DT2H", "P0D"). Returns null for anything else.
 */
export function parseIsoDurationMs(value: string | undefined): number | null {
  if (!value || value === 'P' || value.endsWith('T')) return null;
  const m = ISO_DURATION.exec(value);
  if (!m) return null;
  const [, d, h, min, s] = m;
  const seconds =
    Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(min ?? 0) * 60 + Number(s ?? 0);
  return Math.round(seconds * 1000);
}
