/** Minimal CBOR encoder: just what WebAuthn attestation objects and COSE keys need. */
export type CborValue = number | string | Uint8Array | CborValue[] | Map<number | string, CborValue>;

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

export function encodeCbor(v: CborValue): Uint8Array {
  const out: number[] = [];
  const walk = (x: CborValue): void => {
    if (typeof x === "number") {
      if (!Number.isInteger(x)) throw new Error("only integers supported");
      out.push(...(x >= 0 ? head(0, x) : head(1, -1 - x)));
    } else if (typeof x === "string") {
      const b = new TextEncoder().encode(x);
      out.push(...head(3, b.length), ...b);
    } else if (x instanceof Uint8Array) {
      out.push(...head(2, x.length), ...x);
    } else if (Array.isArray(x)) {
      out.push(...head(4, x.length));
      x.forEach(walk);
    } else {
      out.push(...head(5, x.size));
      for (const [k, val] of x) {
        walk(k);
        walk(val);
      }
    }
  };
  walk(v);
  return new Uint8Array(out);
}
