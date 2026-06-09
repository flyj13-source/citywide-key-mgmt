import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;

function getKey(): Buffer {
  const keyHex = process.env.ENCRYPTION_KEY || '';
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== KEY_LENGTH) {
    return crypto.scryptSync('citywide-default-key', 'salt', KEY_LENGTH);
  }
  return key;
}

export function encrypt(plaintext: string): { encrypted: string; iv: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: Buffer.concat([encrypted, tag]).toString('hex'),
    iv: iv.toString('hex'),
  };
}

export function decrypt(encryptedHex: string, ivHex: string): string {
  const iv = Buffer.from(ivHex, 'hex');
  const data = Buffer.from(encryptedHex, 'hex');
  const tag = data.slice(-16);
  const encrypted = data.slice(0, -16);
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final('utf8');
}
