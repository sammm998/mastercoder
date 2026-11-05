import nodemailer from "nodemailer";
import { selectAdapter } from "@forge/shared";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(msg: EmailMessage): Promise<{ id: string }>;
}

/** Real SMTP (Mailpit in dev, an EU SMTP relay in production). */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp";
  private transport: nodemailer.Transporter;
  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(url);
  }
  async send(msg: EmailMessage) {
    const info = await this.transport.sendMail({ from: this.from, ...msg });
    return { id: String(info.messageId) };
  }
}

/** Records emails in memory; used by tests. Never delivers anything. */
export class MockEmailProvider implements EmailProvider {
  readonly name = "mock";
  readonly sent: EmailMessage[] = [];
  async send(msg: EmailMessage) {
    this.sent.push(msg);
    return { id: `mock-${this.sent.length}` };
  }
}

export function createEmailProvider(): EmailProvider {
  return selectAdapter<EmailProvider>(
    "EMAIL_PROVIDER",
    {
      smtp: () =>
        new SmtpEmailProvider(process.env.SMTP_URL || "smtp://localhost:1025", process.env.EMAIL_FROM || "Forge <noreply@forge.local>"),
      mock: () => new MockEmailProvider(),
    },
    "smtp",
  ).instance;
}
