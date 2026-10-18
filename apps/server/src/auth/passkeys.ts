import { and, eq, gt } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Services } from "../services.js";
import { passkeys, users, webauthnChallenges } from "../db/schema.js";

const CHALLENGE_TTL_MS = 5 * 60_000;
type Kind = "register" | "login";

/** WebAuthn option interfaces lack an index signature; widen them for the JSON response schema. */
const asJson = <T extends { challenge: string }>(o: T): T & Record<string, unknown> =>
  o as T & Record<string, unknown>;

/** Passkey (WebAuthn) registration and login, with challenges stored in Postgres. */
export class Passkeys {
  constructor(private readonly s: Pick<Services, "db" | "config">) {}

  private async saveChallenge(kind: Kind, challenge: string, userId: string | null) {
    const [row] = await this.s.db.db
      .insert(webauthnChallenges)
      .values({ kind, challenge, userId, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) })
      .returning();
    if (!row) throw new Error("challenge insert failed");
    return row.id;
  }

  /** Single-use: the challenge row is deleted when taken. */
  private async takeChallenge(id: string, kind: Kind) {
    const [row] = await this.s.db.db
      .delete(webauthnChallenges)
      .where(
        and(
          eq(webauthnChallenges.id, id),
          eq(webauthnChallenges.kind, kind),
          gt(webauthnChallenges.expiresAt, new Date()),
        ),
      )
      .returning();
    return row ?? null;
  }

  async registrationOptions(userId: string, email: string) {
    const existing = await this.s.db.db.select().from(passkeys).where(eq(passkeys.userId, userId));
    const options = await generateRegistrationOptions({
      rpName: "NorthBot",
      rpID: this.s.config.RP_ID,
      userName: email,
      userID: new TextEncoder().encode(userId),
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({
        id: p.id,
        transports: p.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    const challengeId = await this.saveChallenge("register", options.challenge, userId);
    return { challengeId, options: asJson(options) };
  }

  async verifyRegistration(userId: string, challengeId: string, response: RegistrationResponseJSON) {
    const ch = await this.takeChallenge(challengeId, "register");
    if (!ch || ch.userId !== userId) return null;
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: this.s.config.WEB_ORIGIN,
      expectedRPID: this.s.config.RP_ID,
    });
    if (!result.verified || !result.registrationInfo) return null;
    const cred = result.registrationInfo.credential;
    await this.s.db.db.insert(passkeys).values({
      id: cred.id,
      userId,
      publicKey: Buffer.from(cred.publicKey),
      counter: cred.counter,
      transports: cred.transports ?? [],
    });
    return cred.id;
  }

  async loginOptions() {
    // Discoverable credentials: the authenticator picks the account, so no email is needed.
    const options = await generateAuthenticationOptions({
      rpID: this.s.config.RP_ID,
      userVerification: "preferred",
    });
    const challengeId = await this.saveChallenge("login", options.challenge, null);
    return { challengeId, options: asJson(options) };
  }

  /** Returns the signed-in user, or null when verification fails. */
  async verifyLogin(challengeId: string, response: AuthenticationResponseJSON) {
    const ch = await this.takeChallenge(challengeId, "login");
    if (!ch) return null;
    const [row] = await this.s.db.db
      .select({ pk: passkeys, user: users })
      .from(passkeys)
      .innerJoin(users, eq(users.id, passkeys.userId))
      .where(eq(passkeys.id, response.id));
    if (!row) return null;
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: this.s.config.WEB_ORIGIN,
      expectedRPID: this.s.config.RP_ID,
      credential: {
        id: row.pk.id,
        publicKey: new Uint8Array(row.pk.publicKey),
        counter: row.pk.counter,
        transports: row.pk.transports as AuthenticatorTransportFuture[],
      },
    });
    if (!result.verified) return null;
    await this.s.db.db
      .update(passkeys)
      .set({ counter: result.authenticationInfo.newCounter })
      .where(eq(passkeys.id, row.pk.id));
    return row.user;
  }
}
