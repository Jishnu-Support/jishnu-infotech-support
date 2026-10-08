import nodemailer from "nodemailer";

const host = process.env.SMTP_HOST;
const port = Number(process.env.SMTP_PORT || 587);
const from = process.env.SMTP_FROM || process.env.SMTP_USER;
const smtpConfigured = Boolean(host && from);

const transporter = smtpConfigured
  ? nodemailer.createTransport({
      host,
      port,
      secure: process.env.SMTP_SECURE === "true" || port === 465,
      auth: process.env.SMTP_USER && process.env.SMTP_PASSWORD
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
        : undefined,
    })
  : null;

export function applicationUrl(path) {
  const baseUrl = (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:5173").replace(/\/+$/, "");
  return new URL(path, `${baseUrl}/`).toString();
}

export function emailIsConfigured() {
  return smtpConfigured;
}

export async function sendEmail({ to, subject, text, html, headers, messageId }) {
  if (!transporter) throw new Error("Configure SMTP_HOST and SMTP_FROM (plus authentication if required) to enable outbound email.");
  return transporter.sendMail({ from, to, subject, text, html, headers, messageId });
}

export async function verifyEmailTransport() {
  if (!transporter) return false;
  await transporter.verify();
  return true;
}
