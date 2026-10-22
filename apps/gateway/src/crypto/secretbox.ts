import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface Sealed {
  ct: Buffer; // ciphertext || 16-byte GCM tag
  iv: Buffer;
  kid: string;
}

/**
 * AES-256-GCM envelope for upstream credentials.
 * AAD = the upstream's id, so a ciphertext copied onto another row fails to decrypt
 * (stops "swap the GitHub PAT onto my server" attacks by someone with DB write access).
 * `kid` lets us rotate keys: add a new KEK, make it active (bootstrap re-seals old rows), then drop the old one.
 */
export class SecretBox {
  constructor(
    private readonly keys: Map<string, Buffer>,
    readonly activeKid: string,
  ) {}

  seal(plaintext: string, aad: string): Sealed {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.keys.get(this.activeKid)!, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final(), c.getAuthTag()]);
    return { ct, iv, kid: this.activeKid };
  }

  open(s: Sealed, aad: string): string {
    const key = this.keys.get(s.kid);
    if (!key) throw new Error(`unknown key id ${s.kid}`);
    const d = createDecipheriv('aes-256-gcm', key, s.iv);
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(s.ct.subarray(s.ct.length - 16));
    return Buffer.concat([d.update(s.ct.subarray(0, s.ct.length - 16)), d.final()]).toString('utf8');
  }
}
