// @forge-kit:server-only
import nodemailer from "nodemailer";

export interface EmailMessage {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  /** Overrides EMAIL_FROM. */
  from?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(msg: EmailMessage): Promise<{ id: string }>;
}

function sender(msg: EmailMessage): string {
  const from = msg.from ?? process.env.EMAIL_FROM;
  if (!from) throw new Error("EMAIL_FROM is not set");
  return from;
}

function recipients(to: string | string[]): string[] {
  return Array.isArray(to) ? to : [to];
}

/** Any SMTP server (Mailpit locally, your provider's SMTP relay in production). */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp";
  private readonly transport: ReturnType<typeof nodemailer.createTransport>;
  constructor(url: string = process.env.SMTP_URL ?? "smtp://localhost:1025") {
    this.transport = nodemailer.createTransport(url);
  }
  async send(msg: EmailMessage): Promise<{ id: string }> {
    const info = await this.transport.sendMail({ from: sender(msg), to: recipients(msg.to), subject: msg.subject, text: msg.text, html: msg.html, replyTo: msg.replyTo });
    return { id: String(info.messageId) };
  }
}

/** Resend HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";
  constructor(private readonly apiKey: string = process.env.RESEND_API_KEY ?? "") {
    if (!this.apiKey) throw new Error("RESEND_API_KEY is not set");
  }
  async send(msg: EmailMessage): Promise<{ id: string }> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: sender(msg), to: recipients(msg.to), subject: msg.subject, text: msg.text, html: msg.html, reply_to: msg.replyTo }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok || !body.id) throw new Error(`Resend failed (${res.status}): ${body.message ?? "unknown error"}`);
    return { id: body.id };
  }
}

/** Postmark HTTP API (https://postmarkapp.com/developer/api/email-api). */
export class PostmarkEmailProvider implements EmailProvider {
  readonly name = "postmark";
  constructor(private readonly token: string = process.env.POSTMARK_SERVER_TOKEN ?? "") {
    if (!this.token) throw new Error("POSTMARK_SERVER_TOKEN is not set");
  }
  async send(msg: EmailMessage): Promise<{ id: string }> {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { "X-Postmark-Server-Token": this.token, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ From: sender(msg), To: recipients(msg.to).join(","), Subject: msg.subject, TextBody: msg.text, HtmlBody: msg.html, ReplyTo: msg.replyTo, MessageStream: "outbound" }),
    });
    const body = (await res.json().catch(() => ({}))) as { MessageID?: string; Message?: string; ErrorCode?: number };
    if (!res.ok || body.ErrorCode || !body.MessageID) throw new Error(`Postmark failed (${res.status}): ${body.Message ?? "unknown error"}`);
    return { id: body.MessageID };
  }
}

let provider: EmailProvider | null = null;

/** EMAIL_PROVIDER=smtp|resend|postmark (default smtp). */
export function getEmailProvider(): EmailProvider {
  if (provider) return provider;
  const name = (process.env.EMAIL_PROVIDER ?? "smtp").toLowerCase();
  provider = name === "resend" ? new ResendEmailProvider() : name === "postmark" ? new PostmarkEmailProvider() : new SmtpEmailProvider();
  return provider;
}

export function sendEmail(msg: EmailMessage): Promise<{ id: string }> {
  return getEmailProvider().send(msg);
}

/** Escape user-controlled text before putting it into an HTML email body. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
