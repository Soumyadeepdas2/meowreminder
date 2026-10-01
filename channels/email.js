// email.js — sends reminders by email using SMTP (works with Gmail app passwords).
const nodemailer = require('nodemailer');
const store = require('../store');

function cfg() {
  return store.getConfig().email;
}

module.exports = {
  id: 'email',
  name: 'Email',
  hint: () => 'Add SMTP details (e.g. Gmail + app password) to email reminders.',
  connectedHint: () => 'Connected — reminders are emailed as a backup.',
  isConfigured() {
    const c = cfg();
    return !!(c.user && c.pass && c.from && c.to);
  },
  async send(task) {
    const c = cfg();
    const transporter = nodemailer.createTransport({
      host: c.host,
      port: Number(c.port) || 587,
      secure: c.secure === true,
      auth: { user: c.user, pass: c.pass }
    });

    const when = new Date(task.dueAt).toLocaleString('en-IN', { timeZone: store.getConfig().timezone });

    await transporter.sendMail({
      from: c.from,
      to: c.to,
      subject: '⏰ ' + task.title,
      text: task.title + '\n\nScheduled for ' + when + '\n\n— meow · you heard me.',
      html:
        '<h2>⏰ ' + task.title + '</h2>' +
        '<p>Scheduled for <b>' + when + '</b></p>' +
        '<p style="color:#888">— meow · you heard me.</p>'
    });
    return true;
  }
};
