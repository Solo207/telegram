'use strict';
// Run ONCE (locally or in the EasyPanel console):  node generate-session.js
// Prints a session string -> put it in the TG_SESSION env var.
const readline = require('readline');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

(async () => {
  const apiId = Number(process.env.TG_API_ID || (await ask('API ID: ')));
  const apiHash = process.env.TG_API_HASH || (await ask('API hash: '));
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

  await client.start({
    phoneNumber: () => ask('Phone (with country code, e.g. +234...): '),
    phoneCode: () => ask('Login code from Telegram: '),
    password: () => ask('2FA password (leave empty if none): '),
    onError: (e) => console.error(e),
  });

  console.log('\n=== SESSION STRING (keep secret, it is full access to your account) ===\n');
  console.log(client.session.save());
  console.log('\n=======================================================================');
  await client.disconnect();
  rl.close();
  process.exit(0);
})();
