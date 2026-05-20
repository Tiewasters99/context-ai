// App-layer encryption for stored integration credentials (migration 026).
//
// OAuth refresh tokens are encrypted before they are written to the
// connections table, so a database dump never exposes a usable token.
// AES-256-GCM (authenticated encryption); the 32-byte key is derived by
// SHA-256 over the CONNECTIONS_ENC_KEY env var, so that var can be any
// sufficiently-random string.
//
// Wire format of an encrypted value:  base64(iv):base64(tag):base64(ciphertext)

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function key() {
  const raw = process.env.CONNECTIONS_ENC_KEY;
  if (!raw || raw.length < 16) {
    throw new Error('CONNECTIONS_ENC_KEY is missing or too short');
  }
  return createHash('sha256').update(raw).digest(); // 32 bytes
}

export function encrypt(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    tag.toString('base64'),
    enc.toString('base64'),
  ].join(':');
}

export function decrypt(blob) {
  const [ivB64, tagB64, encB64] = String(blob).split(':');
  if (!ivB64 || !tagB64 || !encB64) {
    throw new Error('connections-crypto: malformed ciphertext');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key(),
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
