import { createRequire } from "node:module";
import type sodiumTypes from "libsodium-wrappers";

// The CommonJS build is used on purpose: the package's ESM entry has had broken imports.
const sodium = createRequire(import.meta.url)("libsodium-wrappers") as typeof sodiumTypes;

export interface Sealed {
  nonce: Buffer;
  ciphertext: Buffer;
}

/** libsodium crypto_secretbox with one subkey per workspace, derived from the master key. */
export class SecretBox {
  private constructor(private readonly master: Uint8Array) {}

  static async create(masterKeyB64: string): Promise<SecretBox> {
    await sodium.ready;
    const master = Buffer.from(masterKeyB64, "base64");
    if (master.length !== sodium.crypto_secretbox_KEYBYTES) {
      throw new Error("NORTHBOT_MASTER_KEY must be base64 of exactly 32 bytes");
    }
    return new SecretBox(new Uint8Array(master));
  }

  private subkey(scope: string): Uint8Array {
    return sodium.crypto_generichash(sodium.crypto_secretbox_KEYBYTES, `northbot:${scope}`, this.master);
  }

  seal(scope: string, plaintext: string): Sealed {
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const ct = sodium.crypto_secretbox_easy(plaintext, nonce, this.subkey(scope));
    return { nonce: Buffer.from(nonce), ciphertext: Buffer.from(ct) };
  }

  open(scope: string, sealed: Sealed): string {
    const pt = sodium.crypto_secretbox_open_easy(
      new Uint8Array(sealed.ciphertext),
      new Uint8Array(sealed.nonce),
      this.subkey(scope),
    );
    return sodium.to_string(pt);
  }
}
