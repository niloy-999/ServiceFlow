import { Injectable } from "@nestjs/common";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const NONCE_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const TOTP_PERIOD_SECONDS = 30;
const DEFAULT_TOTP_DIGITS = 6;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_SECRET_LENGTH = 20;

@Injectable()
export class MfaCryptoService {
  private readonly encryptionKey: Buffer;

  constructor() {
    const configuredKey = process.env.MFA_ENCRYPTION_KEY;

    if (!configuredKey) {
      throw new Error("MFA_ENCRYPTION_KEY is not configured.");
    }

    const decodedKey = Buffer.from(configuredKey, "base64");

    if (decodedKey.length !== 32 || decodedKey.toString("base64") !== configuredKey) {
      throw new Error("MFA_ENCRYPTION_KEY must be a canonical base64-encoded 32-byte key.");
    }

    this.encryptionKey = decodedKey;
  }

  generateTotpSecret(): Buffer {
    return randomBytes(TOTP_SECRET_LENGTH);
  }

  encodeBase32(input: Buffer): string {
    if (!Buffer.isBuffer(input) || input.length === 0) {
      throw new TypeError("A non-empty buffer is required for Base32 encoding.");
    }

    let bits = 0;
    let value = 0;
    let output = "";

    for (const byte of input) {
      value = (value << 8) | byte;
      bits += 8;

      while (bits >= 5) {
        output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }

    if (bits > 0) {
      output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }

    return output;
  }

  decodeBase32(encoded: string): Buffer {
    if (
      typeof encoded !== "string" ||
      encoded.length === 0 ||
      !/^[A-Z2-7]+$/i.test(encoded) ||
      ![0, 2, 4, 5, 7].includes(encoded.length % 8)
    ) {
      throw new TypeError("Invalid unpadded Base32 value.");
    }

    const normalized = encoded.toUpperCase();
    let bits = 0;
    let value = 0;
    const output: number[] = [];

    for (const character of normalized) {
      const digit = BASE32_ALPHABET.indexOf(character);
      if (digit < 0) {
        throw new TypeError("Invalid Base32 character.");
      }

      value = (value << 5) | digit;
      bits += 5;

      if (bits >= 8) {
        output.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }

    if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) {
      throw new TypeError("Non-zero trailing bits in Base32 value.");
    }

    if (output.length === 0) {
      throw new TypeError("Base32 value must decode to at least one byte.");
    }

    return Buffer.from(output);
  }

  createTotpProvisioningUri(secret: Buffer, accountName: string, issuer: string): string {
    if (!Buffer.isBuffer(secret) || secret.length === 0) {
      throw new TypeError("A non-empty TOTP secret is required.");
    }

    if (
      typeof accountName !== "string" ||
      !accountName.trim() ||
      typeof issuer !== "string" ||
      !issuer.trim()
    ) {
      throw new TypeError("A non-empty account name and issuer are required.");
    }

    const normalizedAccount = accountName.trim();
    const normalizedIssuer = issuer.trim();
    const label = encodeURIComponent(`${normalizedIssuer}:${normalizedAccount}`);
    const query = [
      `secret=${this.encodeBase32(secret)}`,
      `issuer=${encodeURIComponent(normalizedIssuer)}`,
      "algorithm=SHA1",
      `digits=${DEFAULT_TOTP_DIGITS}`,
      `period=${TOTP_PERIOD_SECONDS}`,
    ].join("&");

    return `otpauth://totp/${label}?${query}`;
  }

  encryptSecret(secret: Buffer): Buffer {
    if (!Buffer.isBuffer(secret) || secret.length === 0) {
      throw new TypeError("A non-empty MFA secret is required.");
    }

    const nonce = randomBytes(NONCE_LENGTH);
    const cipher = createCipheriv(ENCRYPTION_ALGORITHM, this.encryptionKey, nonce);

    const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);

    const authTag = cipher.getAuthTag();

    return Buffer.concat([nonce, authTag, ciphertext]);
  }

  decryptSecret(encrypted: Buffer): Buffer {
    if (!Buffer.isBuffer(encrypted) || encrypted.length < NONCE_LENGTH + AUTH_TAG_LENGTH + 1) {
      throw new TypeError("Invalid encrypted MFA secret.");
    }

    const nonce = encrypted.subarray(0, NONCE_LENGTH);
    const authTag = encrypted.subarray(NONCE_LENGTH, NONCE_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = encrypted.subarray(NONCE_LENGTH + AUTH_TAG_LENGTH);

    try {
      const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, this.encryptionKey, nonce);

      decipher.setAuthTag(authTag);

      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error("Unable to decrypt MFA secret.");
    }
  }

  generateTotpCode(secret: Buffer, timeStep: number, digits = DEFAULT_TOTP_DIGITS): string {
    if (!Buffer.isBuffer(secret) || secret.length === 0) {
      throw new TypeError("A non-empty TOTP secret is required.");
    }

    if (!Number.isSafeInteger(timeStep) || timeStep < 0) {
      throw new RangeError("TOTP time step must be a non-negative integer.");
    }

    if (digits !== 6 && digits !== 8) {
      throw new RangeError("TOTP digits must be either 6 or 8.");
    }

    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(timeStep));

    const digest = createHmac("sha1", secret).update(counter).digest();

    const offset = digest[digest.length - 1]! & 0x0f;

    const binaryCode =
      ((digest[offset]! & 0x7f) << 24) |
      ((digest[offset + 1]! & 0xff) << 16) |
      ((digest[offset + 2]! & 0xff) << 8) |
      (digest[offset + 3]! & 0xff);

    return String(binaryCode % 10 ** digits).padStart(digits, "0");
  }

  verifyTotpCode(secret: Buffer, code: string, nowMs = Date.now()): number | null {
    if (
      !Buffer.isBuffer(secret) ||
      secret.length === 0 ||
      typeof code !== "string" ||
      !/^\d{6}$/.test(code) ||
      !Number.isSafeInteger(nowMs) ||
      nowMs < 0
    ) {
      return null;
    }

    const currentStep = Math.floor(nowMs / (TOTP_PERIOD_SECONDS * 1000));

    // Accept the previous, current, or next 30-second time step.
    for (const offset of [0, -1, 1]) {
      const candidateStep = currentStep + offset;

      if (candidateStep < 0) {
        continue;
      }

      const expected = Buffer.from(this.generateTotpCode(secret, candidateStep), "ascii");
      const supplied = Buffer.from(code, "ascii");

      if (timingSafeEqual(expected, supplied)) {
        return candidateStep;
      }
    }

    return null;
  }

  generateRecoveryCode(): string {
    const rawCode = randomBytes(16).toString("hex").toUpperCase();

    return rawCode.match(/.{8}/g)!.join("-");
  }

  hashRecoveryCode(code: string): string {
    const normalized = code.replace(/-/g, "").toUpperCase();

    if (!/^[A-F0-9]{32}$/.test(normalized)) {
      throw new TypeError("Invalid recovery code format.");
    }

    return createHash("sha256").update(normalized).digest("hex");
  }
}
