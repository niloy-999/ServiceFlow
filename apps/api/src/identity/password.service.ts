import { Injectable } from "@nestjs/common";
import { hash, parseOptions, verify } from "@node-rs/argon2";

const ARGON2ID = 2;
const ARGON2_VERSION_19 = 1;

const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  version: ARGON2_VERSION_19,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

@Injectable()
export class PasswordService {
  async hashPassword(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  async verifyPassword(password: string, encodedHash: string): Promise<boolean> {
    try {
      parseOptions(encodedHash);
    } catch {
      return false;
    }

    return verify(encodedHash, password);
  }

  needsRehash(encodedHash: string): boolean {
    try {
      const parameters = parseOptions(encodedHash);

      return (
        parameters.algorithm !== ARGON2ID ||
        parameters.version !== ARGON2_VERSION_19 ||
        parameters.memoryCost !== ARGON2_OPTIONS.memoryCost ||
        parameters.timeCost !== ARGON2_OPTIONS.timeCost ||
        parameters.parallelism !== ARGON2_OPTIONS.parallelism ||
        parameters.outputLen !== ARGON2_OPTIONS.outputLen
      );
    } catch {
      return true;
    }
  }
}
