import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { encodeCbor, type CborValue } from "./cbor.js";

const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string): Buffer => createHash("sha256").update(b).digest();

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export interface SoftCredential {
  id: Uint8Array;
  privateKey: KeyObject;
  publicKey: KeyObject;
  userHandle: string;
  signCount: number;
}

/**
 * A software ES256 WebAuthn authenticator ("none" attestation). Tests use it to exercise the
 * passkey flow; the vault uses the same logic to sign challenges with an agent's own passkey.
 */
export class SoftAuthenticator {
  readonly credentials: SoftCredential[] = [];

  constructor(
    private readonly origin: string,
    private readonly rpId: string,
  ) {}

  private authData(flags: number, count: number, attested?: Uint8Array): Buffer {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(count);
    return Buffer.concat([sha256(this.rpId), Buffer.from([flags]), c, attested ?? Buffer.alloc(0)]);
  }

  private clientData(type: string, challenge: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  /** Responds to PublicKeyCredentialCreationOptionsJSON with a RegistrationResponseJSON. */
  create(options: { challenge: string; user: { id: string } }) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const cose = encodeCbor(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x ?? "", "base64url")],
        [-3, Buffer.from(jwk.y ?? "", "base64url")],
      ]),
    );
    const id = randomBytes(16);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(id.length);
    const attested = Buffer.concat([Buffer.alloc(16), len, id, cose]); // zero AAGUID
    const authData = this.authData(FLAG_UP | FLAG_UV | FLAG_AT, 0, attested);
    const attestationObject = encodeCbor(
      new Map<string, CborValue>([
        ["fmt", "none"],
        ["attStmt", new Map<string, CborValue>()],
        ["authData", authData],
      ]),
    );
    this.credentials.push({ id, privateKey, publicKey, userHandle: options.user.id, signCount: 0 });
    return {
      id: b64u(id),
      rawId: b64u(id),
      type: "public-key" as const,
      response: {
        clientDataJSON: b64u(this.clientData("webauthn.create", options.challenge)),
        attestationObject: b64u(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** Responds to PublicKeyCredentialRequestOptionsJSON with an AuthenticationResponseJSON. */
  get(options: { challenge: string; allowCredentials?: { id: string }[] }) {
    const allowed = options.allowCredentials?.map((c) => c.id);
    const cred = this.credentials.find((c) => !allowed?.length || allowed.includes(b64u(c.id)));
    if (!cred) throw new Error("no matching credential");
    cred.signCount += 1;
    const authData = this.authData(FLAG_UP | FLAG_UV, cred.signCount);
    const clientData = this.clientData("webauthn.get", options.challenge);
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientData)]), cred.privateKey);
    return {
      id: b64u(cred.id),
      rawId: b64u(cred.id),
      type: "public-key" as const,
      response: {
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: cred.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
