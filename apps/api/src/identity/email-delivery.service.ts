import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

@Injectable()
export class EmailDeliveryService {
  private readonly deliveryMode = process.env.EMAIL_DELIVERY;

  constructor() {
    if (this.deliveryMode === "local" && process.env.NODE_ENV !== "development") {
      throw new Error("Local email delivery is permitted only in development.");
    }

    if (this.deliveryMode !== "local") {
      throw new Error("No production email delivery provider is configured.");
    }
  }

  async sendVerificationEmail(email: string, verificationUrl: string): Promise<void> {
    const mailDirectory = resolve(process.cwd(), ".local/mail");

    await mkdir(mailDirectory, { recursive: true, mode: 0o700 });
    await chmod(mailDirectory, 0o700);

    const message = [
      `To: ${email}`,
      "Subject: Verify your ServiceFlow email address",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Please verify your ServiceFlow email address using this link:",
      verificationUrl,
      "",
      "This verification link is time-limited and can only be used once.",
      "",
    ].join("\n");

    const filePath = resolve(mailDirectory, `${randomUUID()}.eml`);

    await writeFile(filePath, message, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });

    await chmod(filePath, 0o600);
  }
}
