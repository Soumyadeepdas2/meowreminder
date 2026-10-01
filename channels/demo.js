// demo.js — an always-on "channel" that just succeeds.
// It means the app works out of the box with zero setup: every reminder
// is still recorded in the dashboard's Activity feed even with no
// Telegram/Email configured.
module.exports = {
  id: 'demo',
  name: 'On-screen log',
  hint: () => 'On — every reminder is logged in the dashboard Activity feed.',
  connectedHint: () => 'On — every reminder is logged in the dashboard Activity feed.',
  isConfigured() {
    return true;
  },
  async send() {
    return true;
  }
};
