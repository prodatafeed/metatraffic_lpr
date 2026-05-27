let client;

function getClient() {
  if (client) return client;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  if (!sid) return null;

  // Support both API Key auth (SK...) and Account SID + Auth Token
  if (process.env.TWILIO_API_KEY && process.env.TWILIO_API_SECRET) {
    client = require('twilio')(
      process.env.TWILIO_API_KEY,
      process.env.TWILIO_API_SECRET,
      { accountSid: sid }
    );
  } else {
    client = require('twilio')(sid, process.env.TWILIO_AUTH_TOKEN);
  }
  return client;
}

module.exports = async function sendSMS(to, body) {
  const c = getClient();
  if (!c) {
    console.log(`[SMS-DEV] To: ${to}\n${body}\n`);
    return;
  }
  return c.messages.create({ body, from: process.env.TWILIO_FROM_NUMBER, to });
};
