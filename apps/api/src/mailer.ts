import type { Env } from './types.js';

/**
 * Outbound email, behind an interface.
 *
 * Cloudflare has no built-in transactional sender, so this is the one place the system
 * depends on an outside service. Keeping it behind an interface means the verification and
 * reset *flows* are complete and tested today, and turning email on later is a secret plus
 * a config value — not a code change.
 *
 * When nothing is configured the link is logged to the Worker console and the API says so
 * in its response, so a developer can complete the flow. It never pretends to have sent
 * mail: a silent no-op here would look exactly like a user's spam filter eating the
 * message, and would waste an afternoon.
 */

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export type MailResult =
  | { delivered: true; provider: string }
  | { delivered: false; reason: 'not_configured'; link?: string };

export interface Mailer {
  send(mail: Mail, link?: string): Promise<MailResult>;
}

/** Logs instead of sending. The default until a provider is configured. */
class ConsoleMailer implements Mailer {
  async send(mail: Mail, link?: string): Promise<MailResult> {
    console.log(
      `[mail: NOT SENT — no provider configured]\n  to: ${mail.to}\n  subject: ${mail.subject}` +
        (link ? `\n  link: ${link}` : ''),
    );
    return { delivered: false, reason: 'not_configured', link };
  }
}

/** https://resend.com — one API key, no SDK needed. */
class ResendMailer implements Mailer {
  constructor(private apiKey: string, private from: string) {}

  async send(mail: Mail): Promise<MailResult> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from, to: [mail.to], subject: mail.subject, text: mail.text,
      }),
    });
    if (!res.ok) throw new Error(`Resend rejected the message: ${res.status} ${await res.text()}`);
    return { delivered: true, provider: 'resend' };
  }
}

export function mailerFor(env: Env): Mailer {
  if (env.RESEND_API_KEY && env.MAIL_FROM) {
    return new ResendMailer(env.RESEND_API_KEY, env.MAIL_FROM);
  }
  return new ConsoleMailer();
}

export const mailConfigured = (env: Env): boolean =>
  Boolean(env.RESEND_API_KEY && env.MAIL_FROM);

export function verifyEmailMessage(to: string, link: string): Mail {
  return {
    to,
    subject: 'Confirm your ScreenRegister email',
    text:
      `Confirm this address to finish setting up your ScreenRegister account:\n\n${link}\n\n` +
      `The link expires in one hour and works once.\n\n` +
      `If you did not create an account, ignore this message — nothing was recorded.\n`,
  };
}

export function resetPasswordMessage(to: string, link: string): Mail {
  return {
    to,
    subject: 'Reset your ScreenRegister password',
    text:
      `Use this link to choose a new password:\n\n${link}\n\n` +
      `The link expires in one hour and works once. Setting a new password signs out every ` +
      `other device.\n\n` +
      `If you did not ask for this, ignore the message — your password has not changed. ` +
      `Someone may have typed your address by mistake.\n`,
  };
}
