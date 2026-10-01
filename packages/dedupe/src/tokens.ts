/**
 * Title/caption normalization for near-duplicate matching. Deterministic and
 * language-light: lowercase, strip accents, URLs, @mentions and emoji, keep
 * hashtag words, drop stopwords and GENERIC tags (#funny, #fyp, #shorts …) that
 * say nothing about which clip it is. Numbers are kept separately because
 * differing numbers ("part 1" vs "part 2") are evidence of DIFFERENT videos.
 */

const STOPWORDS = new Set(
  (
    'a an and are as at be but by for from has have he her his i if in into is it its just me my ' +
    'no not of on or our she so than that the their them then there they this to too was we were ' +
    'what when where which who why will with you your yours im its dont cant wont got get gets ' +
    'this these those how all any can do does did been being very really new now here'
  ).split(' '),
);

/** Tags and words so common on short-form platforms that sharing them means nothing. */
const GENERIC = new Set(
  (
    'funny fyp foryou foryoupage fy fypage viral shorts short trending trend lol lmao meme memes ' +
    'comedy humor humour tiktok reels reel video videos clip clips youtube twitch explore xyzbca ' +
    'capcut edit fun laugh hilarious watch wait end omg best'
  ).split(' '),
);

export interface TextTokens {
  /** Distinctive word tokens (stopwords and generic tags removed). */
  words: string[];
  /** Numeric tokens (part numbers, years, counts). */
  numbers: string[];
}

export function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[\w.]+/g, ' ')
    .replace(/#/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function tokenize(...parts: (string | null | undefined)[]): TextTokens {
  const words = new Set<string>();
  const numbers = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    for (const raw of normalizeText(part).split(' ')) {
      if (!raw) continue;
      if (/^\d+$/.test(raw)) {
        numbers.add(String(Number(raw)));
        continue;
      }
      // Light plural folding so "cats"/"cat" match; never below 3 letters.
      const token =
        raw.length > 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw;
      if (token.length < 3 || STOPWORDS.has(token) || GENERIC.has(token) || GENERIC.has(raw)) {
        continue;
      }
      words.add(token);
    }
  }
  return { words: [...words].sort(), numbers: [...numbers].sort() };
}

/** Tokens stored on the video row for indexed candidate search ("n:" marks numbers). */
export function matchTokens(tokens: TextTokens): string[] {
  return [...tokens.words, ...tokens.numbers.map((n) => `n:${n}`)];
}

export function parseMatchTokens(stored: readonly string[] | null): TextTokens {
  const words: string[] = [];
  const numbers: string[] = [];
  for (const t of stored ?? []) (t.startsWith('n:') ? numbers : words).push(t.replace(/^n:/, ''));
  return { words, numbers };
}

export interface TitleComparison {
  /** |A∩B| / |A∪B| over distinctive words. */
  jaccard: number;
  /** |A∩B| / min(|A|,|B|): reposts often shorten or extend a title. */
  containment: number;
  shared: string[];
  /** Both sides carry numbers and they disagree (e.g. "part 1" vs "part 2"). */
  numbersConflict: boolean;
}

export function compareTokens(a: TextTokens, b: TextTokens): TitleComparison | null {
  if (a.words.length === 0 || b.words.length === 0) return null;
  const setB = new Set(b.words);
  const shared = a.words.filter((w) => setB.has(w));
  const union = new Set([...a.words, ...b.words]).size;
  const numbersB = new Set(b.numbers);
  const numbersConflict =
    a.numbers.length > 0 &&
    b.numbers.length > 0 &&
    (a.numbers.some((n) => !numbersB.has(n)) || b.numbers.length !== a.numbers.length);
  return {
    jaccard: shared.length / union,
    containment: shared.length / Math.min(a.words.length, b.words.length),
    shared,
    numbersConflict,
  };
}
