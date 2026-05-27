const nodemailer = require('nodemailer');

let transport;

function getTransport() {
  if (transport) return transport;
  if (!process.env.SES_FROM_EMAIL) return null;
  transport = nodemailer.createTransport({
    host: process.env.SES_SMTP_HOST || 'email-smtp.us-east-1.amazonaws.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.SES_SMTP_USER,
      pass: process.env.SES_SMTP_PASS,
    },
  });
  return transport;
}

module.exports = async function sendEmail({ to, subject, html }) {
  const t = getTransport();
  if (!t) {
    console.log(`[EMAIL-DEV] To: ${to} | Subject: ${subject}\n${html.replace(/<[^>]+>/g, '').trim()}\n`);
    return;
  }
  return t.sendMail({
    from: process.env.SES_FROM_EMAIL,
    to,
    subject,
    html,
  });
};
