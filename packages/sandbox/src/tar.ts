/** Minimal ustar writer: one regular file, enough for Docker's putArchive. */
function header(name: string, size: number, mode: number, uid: number): Buffer {
  const h = Buffer.alloc(512, 0);
  const put = (s: string, off: number, len: number) => h.write(s.slice(0, len), off, len, "utf8");
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(name, 0, 100);
  put(oct(mode, 8), 100, 8);
  put(oct(uid, 8), 108, 8);
  put(oct(uid, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(Math.floor(Date.now() / 1000), 12), 136, 12);
  h.fill(" ", 148, 156); // checksum placeholder
  put("0", 156, 1); // regular file
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

export function tarOneFile(name: string, data: Buffer, opts: { mode?: number; uid?: number } = {}): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error("file name too long for this archive");
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([header(name, data.length, opts.mode ?? 0o644, opts.uid ?? 1001), data, Buffer.alloc(pad), Buffer.alloc(1024)]);
}
