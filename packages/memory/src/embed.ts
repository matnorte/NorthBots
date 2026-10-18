/** Turns text into a unit vector. Implementations must be deterministic for a given model. */
export interface Embedder {
  readonly model: string;
  readonly dims: number;
  embed(texts: string[]): Promise<number[][]>;
}

const STOP = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "be", "it", "this", "that", "with",
  "as", "at", "by", "from", "my", "our", "your", "i", "we", "you", "de", "da", "do", "e", "o", "a", "os", "as", "um", "uma",
  "el", "la", "los", "las", "y", "en", "que", "para", "what", "when", "where", "which", "who", "how", "do", "does", "did",
  "can", "could", "should", "would", "will", "please", "about", "into", "there", "their", "they", "them", "its", "has", "have",
]);

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Light, consistent stemming: "invoices"/"invoice", "closes"/"close", "boxes"/"box", "running"/"run". */
function stem(w: string): string {
  let s = w;
  if (s.length > 4 && s.endsWith("ies")) s = `${s.slice(0, -3)}y`;
  else if (s.length > 4 && /(ss|x|z|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
  return s.slice(0, 12);
}

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

/**
 * Local, offline embedder: hashed bag of word stems plus character trigrams (the "hashing
 * trick"). Not as smart as a model, but private, free and deterministic; good enough to find
 * repeated tasks and related memories. Swap in a provider embedder for better recall.
 */
export class HashEmbedder implements Embedder {
  readonly model: string;
  constructor(readonly dims = 1024) {
    this.model = `northbot-hash2-${dims}`;
  }

  embedOne(text: string): number[] {
    const v = new Array<number>(this.dims).fill(0);
    // Each feature goes to two buckets, so one unlucky collision cannot erase it.
    const add = (feature: string, weight: number) => {
      for (const probe of [feature, `${feature}#2`]) {
        const h = fnv1a(probe);
        v[h % this.dims]! += h & 0x80000000 ? -weight : weight;
      }
    };
    for (const w of tokens(text)) {
      add(`w:${w}`, 1);
      const padded = `_${w}_`;
      for (let i = 0; i + 3 <= padded.length; i++) add(`t:${padded.slice(i, i + 3)}`, 0.3);
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
