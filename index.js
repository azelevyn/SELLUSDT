// index.js
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const CoinPayments = require('coinpayments');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '').split(',').map(s => s.trim()).filter(Boolean);
const MIN_USDT = Number(process.env.MIN_USDT || 25);
const MAX_USDT = Number(process.env.MAX_USDT || 50000);
const USE_WEBHOOK = (process.env.USE_WEBHOOK === 'true');

if (!TELEGRAM_TOKEN) {
  console.error("Set TELEGRAM_TOKEN in .env");
  process.exit(1);
}

// CoinPayments client
const cpClient = new CoinPayments({
  key: process.env.COINPAYMENTS_KEY,
  secret: process.env.COINPAYMENTS_SECRET
});

// SQLite DB
const db = new sqlite3.Database('./bot.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id INTEGER UNIQUE,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    referral_code TEXT,
    referred_by TEXT,
    balance REAL DEFAULT 0,
    referral_balance REAL DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS deposits (
    id TEXT PRIMARY KEY,
    user_id INTEGER,
    amount REAL,
    currency TEXT,
    network TEXT,
    status TEXT,
    coinpayments_txn_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS withdrawals (
    id TEXT PRIMARY KEY,
    user_id INTEGER,
    amount REAL,
    fiat_currency TEXT,
    method TEXT,
    method_data TEXT,
    status TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// Price fetch / rates
const COINGECKO_SIMPLE_PRICE = 'https://api.coingecko.com/api/v3/simple/price';
async function fetchMarketPrices() {
  // USDT to USD/EUR/GBP via CoinGecko (per 1 USDT)
  const res = await axios.get(COINGECKO_SIMPLE_PRICE, {
    params: { ids: 'tether', vs_currencies: 'usd,eur,gbp' },
    timeout: 10000
  });
  return res.data.tether; // { usd:1.0, eur:0.85, gbp:0.76 }
}

// Get effective rate (two modes):
// Mode A: Treat the RATE_MULTIPLIER_* environment values as final per-1-USDT fiat value.
// Mode B: If you want market price + markup, set env MULTIPLIER_* as percentage >1 and uncomment below.
// Current default: use env values directly so it matches your provided numbers.
function getConfiguredRates() {
  return {
    usd: Number(process.env.RATE_MULTIPLIER_USD || 1.05),
    eur: Number(process.env.RATE_MULTIPLIER_EUR || 0.89),
    gbp: Number(process.env.RATE_MULTIPLIER_GBP || 0.79)
  };
}

// If you prefer market price + markup, you can compute:
// const market = await fetchMarketPrices(); finalUsd = market.usd * Number(process.env.MARKUP_USD||1.05);

// Setup Telegram
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: !USE_WEBHOOK });
if (USE_WEBHOOK) {
  // If using webhook, use express to receive updates (Sevalla production).
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.post('/webhook', (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
  const port = process.env.PORT || 3000;
  app.listen(port, () => { console.log('Webhook server listening on', port); });
  bot.setWebHook(process.env.WEBHOOK_URL || '');
}

// Helpers
function getOrCreateUser(msg, cb) {
  const tgId = msg.from.id;
  db.get('SELECT * FROM users WHERE tg_id = ?', [tgId], (err, row) => {
    if (err) return cb(err);
    if (row) return cb(null, row);
    const referral_code = uuidv4().slice(0,8);
    db.run(`INSERT INTO users (tg_id, username, first_name, last_name, referral_code) VALUES (?,?,?,?,?)`,
      [tgId, msg.from.username || null, msg.from.first_name||null, msg.from.last_name||null], function(err){
        if (err) return cb(err);
        db.get('SELECT * FROM users WHERE id = ?', [this.lastID], (e, newRow) => cb(e, newRow));
      });
  });
}

function isAdmin(username) {
  return ADMIN_USERNAMES.includes(username);
}

// Start command
bot.onText(/\/start(?: (.+))?/, (msg, match) => {
  const payload = match[1]; // may include referral code
  getOrCreateUser(msg, (err, user) => {
    if (err) return bot.sendMessage(msg.chat.id, 'Error creating user.');
    if (payload) {
      // treat payload as referral code
      db.run('UPDATE users SET referred_by = ? WHERE tg_id = ? AND referred_by IS NULL', [payload, msg.from.id]);
    }
    const rates = getConfiguredRates();
    const reply = `Hello ${msg.from.first_name || ''} — welcome!\n\nAvailable fiat: USD / EUR / GBP\nSell USDT (ERC.20 / TRC.20). Minimum: ${MIN_USDT} USDT, Maximum: ${MAX_USDT} USDT.\n\nCurrent rates (per 1 USDT):\nUSD: ${rates.usd}\nEUR: ${rates.eur}\nGBP: ${rates.gbp}\n\nUse the menu:`,
    opts = {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Sell USDT', callback_data: 'sell' }, { text: 'Wallet', callback_data: 'wallet' }],
          [{ text: 'Referral', callback_data: 'referral' }, { text: 'Help', callback_data: 'help' }]
        ]
      }
    };
    bot.sendMessage(msg.chat.id, reply, opts);
  });
});

// Callback queries (menus)
bot.on('callback_query', async (q) => {
  const chatId = q.message.chat.id;
  if (q.data === 'help') {
    return bot.sendMessage(chatId, `Choose Sell USDT -> choose fiat and payment method -> provide payment details -> deposit USDT via ERC.20/TRC.20.\nReferral: share your /start <code> link. Each successful refer gives 1.5 USDT (withdrawable after balance >= 50 USDT).`);
  }
  if (q.data === 'referral') {
    db.get('SELECT * FROM users WHERE tg_id = ?', [q.from.id], (err, row) => {
      if (err || !row) return bot.sendMessage(chatId, 'No user found.');
      bot.sendMessage(chatId, `Your referral code: ${row.referral_code}\nShare this link: https://t.me/${(process.env.BOT_USERNAME||'yourbot')}?start=${row.referral_code}\nReferral reward: 1.5 USDT. Withdrawable when you reach 50 USDT total.`);
    });
    return;
  }
  if (q.data === 'wallet') {
    db.get('SELECT * FROM users WHERE tg_id = ?', [q.from.id], (err, row) => {
      if (err || !row) return bot.sendMessage(chatId, 'Error retrieving wallet.');
      const text = `Wallet balance: ${row.balance.toFixed(6)} USDT\nReferral balance: ${row.referral_balance.toFixed(6)} USDT\n\nButtons:\n- Withdraw\n- Deposit`;
      const opts = { reply_markup: { inline_keyboard: [[{text:'Deposit', callback_data:'deposit'},{text:'Withdraw', callback_data:'withdraw'}]] } };
      bot.sendMessage(chatId, text, opts);
    });
    return;
  }
  if (q.data === 'sell' || q.data === 'deposit') {
    // Step 1: choose fiat
    const opts = { reply_markup: { inline_keyboard: [
      [{text:'USD', callback_data:'fiat_USD'},{text:'EUR', callback_data:'fiat_EUR'},{text:'GBP', callback_data:'fiat_GBP'}],
      [{text:'Cancel', callback_data:'cancel'}]
    ] } };
    return bot.sendMessage(chatId, 'Choose fiat currency you want to receive:', opts);
  }
  if (/^fiat_/.test(q.data)) {
    const fiat = q.data.split('_')[1]; // USD/EUR/GBP
    // store temporary context in memory (for brevity we attach to user in memory store)
    if (!global.pending) global.pending = {};
    global.pending[q.from.id] = { step: 'fiat_selected', fiat };
    // payment method selection
    const methods = [
      'Wise','PayPal','Revolut','Bank Transfer','Alipay','Card Number','Skrill','Neteller','Payeer'
    ];
    const kb = [];
    for (let m of methods) kb.push([{ text: m, callback_data: `pm_${m.replace(/\s+/g,'_')}` }]);
    kb.push([{text:'Back', callback_data:'sell'}]);
    return bot.sendMessage(chatId, `You chose ${fiat}. Choose payment method:`, { reply_markup: { inline_keyboard: kb }});
  }
  if (/^pm_/.test(q.data)) {
    const method = q.data.slice(3).replace(/_/g,' ');
    const ctx = global.pending && global.pending[q.from.id];
    if (!ctx || !ctx.fiat) return bot.sendMessage(chatId, 'Session expired. /start again.');
    ctx.method = method;
    ctx.step = 'method_selected';
    // Ask for specific data based on method
    let ask = '';
    switch (method.toLowerCase()) {
      case 'wise': ask = 'Provide your Wise email or Wise tag (e.g. name@wise.com)'; break;
      case 'paypal': ask = 'Send your PayPal email address'; break;
      case 'revolut': ask = 'Provide your Revolut tag (RevTag) or email'; break;
      case 'bank transfer': {
        // ask EU or US
        ctx.step = 'bank_type';
        return bot.sendMessage(chatId, 'Is this a European bank or a US bank?', { reply_markup: { inline_keyboard: [[{text:'European', callback_data:'bank_EU'},{text:'US', callback_data:'bank_US'}],[{text:'Cancel', callback_data:'cancel'}]] }});
      }
      case 'alipay': ask = 'Provide your Alipay email'; break;
      case 'card number': ask = 'Provide the card number (digits only)'; break;
      case 'skrill': ask = 'Provide your Skrill email'; break;
      case 'neteller': ask = 'Provide your Neteller email'; break;
      case 'payeer': ask = 'Provide your Payeer number'; break;
      default: ask = 'Provide the required payment details'; break;
    }
    ctx.expecting = 'payment_info';
    return bot.sendMessage(chatId, ask);
  }
  if (/^bank_/.test(q.data)) {
    const type = q.data.split('_')[1]; // EU or US
    const ctx = global.pending && global.pending[q.from.id];
    if (!ctx) return bot.sendMessage(chatId, 'Session expired.');
    ctx.bankType = type;
    ctx.expecting = 'payment_info_bank';
    if (type === 'EU') {
      return bot.sendMessage(chatId, 'Please provide: First name, Last name, IBAN, SWIFT (separated by commas)\nExample: John, Doe, GB29NWBK60161331926819, NWBKGB2L');
    } else {
      return bot.sendMessage(chatId, 'Please provide: First name, Last name, Routing number, Account number\nExample: John, Doe, 111000025, 123456789');
    }
  }
  if (q.data === 'withdraw') {
    return bot.sendMessage(chatId, 'To request withdrawal, please use /withdraw command (admin will review).');
  }
  if (q.data === 'cancel') {
    delete global.pending[q.from.id];
    return bot.sendMessage(chatId, 'Cancelled.');
  }
});

// Capture plain text replies for previously asked info
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const ctx = global.pending && global.pending[msg.from.id];
  if (!ctx) return;
  const chatId = msg.chat.id;
  if (ctx.expecting === 'payment_info' || ctx.expecting === 'payment_info_bank') {
    // ask user for how much USDT they want to sell
    ctx.paymentInfo = msg.text.trim();
    ctx.expecting = 'amount';
    return bot.sendMessage(chatId, `Send amount in USDT you want to sell (min ${MIN_USDT}, max ${MAX_USDT})`);
  }
  if (ctx.expecting === 'amount') {
    const amount = Number(msg.text.trim());
    if (!amount || amount < MIN_USDT || amount > MAX_USDT) return bot.sendMessage(chatId, `Invalid amount. Must be between ${MIN_USDT} and ${MAX_USDT} USDT.`);
    ctx.amount = amount;
    // compute fiat payout using configured rates
    const rates = getConfiguredRates(); // uses your env rates
    let fiatPerUsdt = rates[ctx.fiat.toLowerCase()];
    if (!fiatPerUsdt) fiatPerUsdt = rates.usd;
    const payoutFiat = (fiatPerUsdt * amount).toFixed(2);

    // Create CoinPayments transaction to provide deposit address (USDT ERC.20/TRC.20)
    // We'll ask user network choice:
    const keyboard = { reply_markup: { inline_keyboard: [[{text:'ERC.20', callback_data:'net_ERC.20'},{text:'TRC.20', callback_data:'net_TRC.20'}]] } };
    ctx.step = 'choose_network';
    return bot.sendMessage(chatId, `You will receive ${payoutFiat} ${ctx.fiat} via ${ctx.method}. Now choose deposit network (ERC.20 or TRC.20):`, keyboard);
  }
});

// Network callback to create payment
bot.on('callback_query', async (q) => {
  if (!q.data.startsWith('net_')) return;
  const net = q.data.split('_')[1]; // ERC.20 or TRC.20
  const ctx = global.pending && global.pending[q.from.id];
  if (!ctx || !ctx.amount) return bot.sendMessage(q.message.chat.id, 'Session expired.');
  // create CoinPayments transaction for USDT on chosen network
  try {
    // coin: 'usdt', currency: 'USDT' and specify network via 'currency2' or 'token' param depending on API (CoinPayments may need custom fields)
    // We'll call createTransactionSimple with currency 'USDT' and choose network by 'currency2' (user will manually send to the returned address).
    const txnId = uuidv4();
    const cpParams = {
      cmd: 'create_transaction',
      currency1: 'USD',  // input currency - we accept coin, so we'll set currency1 to 'USDT' actually
      currency2: 'USDT',
      amount: ctx.amount,
      buyer_email: (ctx.paymentInfo && ctx.paymentInfo.split(',')[0]) || '',
      item_name: `Sell USDT ${ctx.amount}`,
      invoice: txnId
    };
    // Note: CoinPayments createTransaction usage may vary based on the wrapper. We'll use wrapper method:
    const createRes = await cpClient.createTransaction({
      amount: ctx.amount,
      currency1: 'USDT',
      currency2: 'USDT',
      buyer_email: (ctx.paymentInfo||'') // optional
    });

    //	save deposit in DB
    const depositId = txnId;
    db.get('SELECT id FROM users WHERE tg_id = ?', [q.from.id], (err, userRow) => {
      if (err || !userRow) return bot.sendMessage(q.message.chat.id, 'User not found.');
      db.run(`INSERT INTO deposits (id, user_id, amount, currency, network, status, coinpayments_txn_id)
              VALUES (?,?,?,?,?,?,?)`, [
        depositId, userRow.id, ctx.amount, 'USDT', net, 'waiting', createRes.txn_id || createRes.txn
      ], (e) => {
        if (e) console.error(e);
        // Show payment address / instructions returned by CoinPayments
        const text = `Deposit details:\nAmount: ${ctx.amount} USDT\nNetwork: ${net}\n\nSend exactly ${ctx.amount} USDT to:\n${createRes.address || createRes.payment_address || createRes.result?.address}\n\nTXN ID: ${createRes.txn_id || createRes.txn}\n\nAfter network confirms deposit, your wallet will be credited.`;
        bot.sendMessage(q.message.chat.id, text);
      });
    });

    // Clear session
    delete global.pending[q.from.id];
  } catch (err) {
    console.error('CP error', err);
    bot.sendMessage(q.message.chat.id, 'Error creating payment address. Please contact admin.');
  }
});

// Admin: simple /admin command for username-based admins
bot.onText(/\/admin(?: (.+))?/, (msg, match) => {
  const username = msg.from.username || '';
  if (!isAdmin(username)) return bot.sendMessage(msg.chat.id, 'Unauthorized.');
  // show simple admin menu
  const kb = { reply_markup: { inline_keyboard: [
    [{text:'Show balances', callback_data:'admin_balances'},{text:'List deposits', callback_data:'admin_deposits'}]
  ] } };
  bot.sendMessage(msg.chat.id, 'Admin menu:', kb);
});

bot.on('callback_query', (q) => {
  if (!q.data.startsWith('admin_')) return;
  const username = q.from.username || '';
  if (!isAdmin(username)) return bot.sendMessage(q.message.chat.id, 'Unauthorized.');
  if (q.data === 'admin_balances') {
    db.all('SELECT username, balance, referral_balance FROM users ORDER BY balance DESC LIMIT 50', [], (err, rows) => {
      if (err) return bot.sendMessage(q.message.chat.id, 'Error fetching balances.');
      let text = 'Top users:\n' + rows.map(r => `${r.username||'no_name'} — ${r.balance.toFixed(6)} USDT (ref ${r.referral_balance.toFixed(6)})`).join('\n');
      bot.sendMessage(q.message.chat.id, text);
    });
  }
  if (q.data === 'admin_deposits') {
    db.all('SELECT * FROM deposits ORDER BY created_at DESC LIMIT 20', [], (err, rows) => {
      if (err) return bot.sendMessage(q.message.chat.id, 'Error fetching deposits.');
      const text = rows.map(r => `${r.id} — ${r.amount} ${r.currency} — ${r.network} — ${r.status}`).join('\n');
      bot.sendMessage(q.message.chat.id, text || 'No deposits');
    });
  }
});

// Minimal IPN / webhook for CoinPayments (you must configure IPN on CoinPayments merchant settings)
const express = require('express');
const app = express();
app.use(express.urlencoded({extended:true}));
app.post('/coinpayments-ipn', (req, res) => {
  // CoinPayments sends IPN notifications. Validate HMAC with your secret as per CoinPayments docs.
  // For brevity: assume valid (implement validation in production).
  const { invoice, status, txn_id } = req.body;
  // Update deposit status:
  if (!invoice) { res.status(400).send('no invoice'); return; }
  const newStatus = (Number(status) >= 100 || Number(status) === 2) ? 'complete' : 'pending';
  db.run('UPDATE deposits SET status = ?, coinpayments_txn_id = ? WHERE id = ?', [newStatus, txn_id, invoice], (e) => {
    if (!e && newStatus === 'complete') {
      // credit user's wallet
      db.get('SELECT user_id, amount FROM deposits WHERE id = ?', [invoice], (err, drow) => {
        if (!err && drow) {
          db.run('UPDATE users SET balance = balance + ? WHERE id = ?', [drow.amount, drow.user_id]);
          // handle referral credit: credit 1.5 USDT to the referer if this is first qualifying deposit
          db.get('SELECT referred_by FROM users WHERE id = ?', [drow.user_id], (er, urow) => {
            if (!er && urow && urow.referred_by) {
              // find the referer id via referral_code
              db.get('SELECT id FROM users WHERE referral_code = ?', [urow.referred_by], (err2, refRow) => {
                if (!err2 && refRow) {
                  db.run('UPDATE users SET referral_balance = referral_balance + ? WHERE id = ?', [1.5, refRow.id]);
                }
              });
            }
          });
        }
      });
    }
    res.send('OK');
  });
});
const port = process.env.PORT || 3001;
app.listen(port, () => console.log('IPN listener running on', port));
