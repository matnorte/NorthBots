import { hash, verify } from "@node-rs/argon2";

// OWASP-recommended argon2id parameters (19 MiB, 2 passes).
// algorithm 2 = Argon2id (the package exports it as a const enum, unusable with isolatedModules).
const OPTS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTS);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

/** A fixed hash used to keep login timing the same when the email does not exist. */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword("not-a-real-password-placeholder");
  return dummy;
}
