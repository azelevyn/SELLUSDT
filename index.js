// ============================
// USDT SELLER TELEGRAM BOT
// ============================

// Import necessary libraries
const TelegramBot = require('node-telegram-bot-api');
const CoinPayments = require('coinpayments');
require('dotenv').config();

// --- CONFIGURATION ---
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const merchantId = process.env.COINPAYMENTS_MERCHANT_ID;
const publicKey = process.env.COINPAYMENTS_PUBLIC_KEY;
const privateKey = process.env.COINPAYMENTS_PRIVATE_KEY;
const buyerRefundEmail = process.env.BUYER_REFUND_EMAIL;

// Check essential config
if (!botToken || !merchantId || !publicKey || !privateKey || !buyerRefundEmail) {
    console.error("❌ CRITICAL ERROR: Missing required environment variables. Check your .env file.");
    process.exit(1);
}

// Initialize Telegram Bot
const bot = new TelegramBot(botToken, { polling: true });

// Initialize CoinPayments client
let coinpayments;
try {
    coinpayments = new CoinPayments({
        key: publicKey,
        secret: privateKey,
    });
    console.log("✅ CoinPayments client initialized successfully.");
} catch (error) {
    console.error("❌ Failed to initialize CoinPayments client:", error.message);
    process.exit(1);
}

// --- USER STATE STORAGE ---
const userStates = {};

// Exchange rates (example, static)
const exchangeRates = {
    USD: 1.0,
    EUR: 0.89,
    GBP: 0.77,
    USDT: 1.0,
};

// --- HELPER FUNCTIONS ---
function resetUserState(userId) {
    delete userStates[userId];
    console.log(`🧹 State reset for user ${userId}`);
}

function getTransactionSummary(state) {
    const receiveAmount = (state.amount * exchangeRates[state.currency]).toFixed(2);
    return `
Please confirm your transaction details:

- **Amount to Sell:** ${state.amount} USDT
- **Deposit Network:** ${state.network}
- **Fiat Currency:** ${state.currency}
- **You Will Receive (approx.):** ${receiveAmount} ${state.currency}
- **Payment Method:** ${state.paymentMethod}
- **Your Details:** ${state.paymentDetails}

A payment will be sent to you after the USDT deposit is confirmed.
`;
}

// --- BOT COMMANDS ---
// /start
bot.onText(/\/start/, (msg) => {
    const userId = msg.chat.id;
    const firstName = msg.from.first_name || '';
    const lastName = msg.from.last_name || '';

    resetUserState(userId);

    const welcomeMessage = `
Hello ${firstName} ${lastName},

👋 Welcome to the *USDT Selling Bot*.

I help you securely and efficiently sell your USDT for various fiat currencies.

Press the *MENU* button below to begin.
`;

    bot.sendMessage(userId, welcomeMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            keyboard: [[{ text: 'MENU' }]],
            resize_keyboard: true,
            one_time_keyboard: true
        }
    });
});

// MENU button
bot.onText(/MENU/, (msg) => {
    const userId = msg.chat.id;
    userStates[userId] = { step: 'start' };

    bot.sendMessage(userId, 'Do you want to sell USDT?', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '✅ YES', callback_data: 'sell_usdt_yes' }],
                [{ text: '❌ NO', callback_data: 'sell_usdt_no' }]
            ]
        }
    });
});

// --- MESSAGE HANDLER (user input) ---
bot.on('message', (msg) => {
    const userId = msg.chat.id;
    const userState = userStates[userId];

    // Ignore commands and MENU
    if (msg.text.startsWith('/') || msg.text === 'MENU') return;
    if (!userState || !userState.step) return;

    if (userState.step === 'awaiting_payment_details') {
        userState.paymentDetails = msg.text.trim();
        userState.step = 'awaiting_amount';
        bot.sendMessage(userId, '✅ Got it. Now, please enter the amount of USDT you wish to sell (Min: 25, Max: 50,000).');
    } 
    else if (userState.step === 'awaiting_amount') {
        const amount = parseFloat(msg.text);
        if (isNaN(amount) || amount < 25 || amount > 50000) {
            bot.sendMessage(userId, '⚠️ Invalid amount. Please enter a number between 25 and 50,000.');
            return;
        }

        userState.amount = amount;
        userState.step = 'confirm_transaction';

        const summary = getTransactionSummary(userState);
        bot.sendMessage(userId, summary, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '✅ Confirm & Get Deposit Address', callback_data: 'confirm_transaction' }],
                    [{ text: '❌ Cancel', callback_data: 'cancel_transaction' }]
                ]
            }
        });
    }
});

// --- CALLBACK QUERY HANDLER ---
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const userId = msg.chat.id;
    const data = callbackQuery.data;

    bot.answerCallbackQuery(callbackQuery.id);

    if (!userStates[userId]) userStates[userId] = { step: 'start' };
    const userState = userStates[userId];

    try {
        switch (true) {
            case data === 'sell_usdt_yes':
                userState.step = 'select_currency';
                bot.sendMessage(userId, 'Please select your preferred fiat currency:', {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: 'USD', callback_data: 'currency_USD' },
                                { text: 'EUR', callback_data: 'currency_EUR' },
                                { text: 'GBP', callback_data: 'currency_GBP' }
                            ]
                        ]
                    }
                });
                break;

            case data === 'sell_usdt_no':
            case data === 'cancel_transaction':
                bot.sendMessage(userId, '❌ Transaction cancelled. Type /start to begin again.');
                resetUserState(userId);
                break;

            case data.startsWith('currency_'):
                userState.currency = data.split('_')[1];
                userState.step = 'select_network';
                bot.sendMessage(userId, 'Please select the deposit network:', {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'USDT TRC20', callback_data: 'network_TRC20' }],
                            [{ text: 'USDT ERC20', callback_data: 'network_ERC20' }]
                        ]
                    }
                });
                break;

            case data.startsWith('network_'):
                userState.network = data.split('_')[1];
                userState.step = 'select_payment_method';
                bot.sendMessage(userId, 'Please select your payment method:', {
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: 'Wise', callback_data: 'payment_Wise' },
                                { text: 'Revolut', callback_data: 'payment_Revolut' }
                            ],
                            [
                                { text: 'PayPal', callback_data: 'payment_PayPal' },
                                { text: 'Bank Transfer', callback_data: 'payment_Bank' }
                            ],
                            [
                                { text: 'Skrill/Neteller', callback_data: 'payment_Skrill' },
                                { text: 'Visa/Mastercard', callback_data: 'payment_Card' }
                            ],
                            [
                                { text: 'Payeer', callback_data: 'payment_Payeer' },
                                { text: 'Alipay', callback_data: 'payment_Alipay' }
                            ]
                        ]
                    }
                });
                break;

            case data.startsWith('payment_'):
                const method = data.split('_')[1];
                userState.paymentMethod = method;
                userState.step = 'awaiting_payment_details';

                const prompts = {
                    Wise: 'Please enter your Wise email or tag:',
                    Revolut: 'Please enter your Revolut @revtag:',
                    PayPal: 'Please enter your PayPal email:',
                    Bank: 'Please enter your full IBAN details (Name, IBAN, SWIFT/BIC, Bank Name, Country):',
                    Skrill: 'Please enter your Skrill or Neteller email:',
                    Card: 'Please enter your Visa/Mastercard number:',
                    Payeer: 'Please enter your Payeer account number:',
                    Alipay: 'Please enter your Alipay email:'
                };
                bot.sendMessage(userId, prompts[method] || 'Please provide your payment details.');
                break;

            case data === 'confirm_transaction':
                bot.sendMessage(userId, '🔄 Creating your CoinPayments deposit address...');

                const transactionOptions = {
                    currency1: 'USDT',
                    currency2: 'USDT',
                    amount: userState.amount,
                    buyer_email: buyerRefundEmail,
                    custom: JSON.stringify({
                        telegramId: userId,
                        fiat: userState.currency,
                        method: userState.paymentMethod,
                        details: userState.paymentDetails
                    }),
                    ipn_url: '', // optional webhook URL
                };

                try {
                    const result = await coinpayments.createTransaction(transactionOptions);

                    const depositMessage = `
✅ *Deposit Created Successfully!*

Please send **${result.amount} USDT** to this address:

\`${result.address}\`

🔗 [View Status](${result.status_url})

Once confirmed on blockchain, your fiat payment will be processed automatically.
                    `;

                    bot.sendMessage(userId, depositMessage, { parse_mode: 'Markdown' });

                    if (result.qrcode_url) {
                        bot.sendPhoto(userId, result.qrcode_url, { caption: 'Scan this QR to pay.' });
                    }

                    resetUserState(userId);
                } catch (err) {
                    console.error(`❌ CoinPayments Error for ${userId}:`, err.message);
                    bot.sendMessage(userId, '⚠️ Error creating transaction. Please try again later.');
                    resetUserState(userId);
                }
                break;
        }
    } catch (err) {
        console.error(`Callback error: ${err.message}`);
    }
});

// --- BOT STARTUP ---
console.log('🤖 USDT Seller Bot is running...');

// Graceful shutdown
process.on('SIGINT', () => {
    console.log("🛑 Shutting down bot...");
    process.exit();
});
process.on('SIGTERM', () => {
    console.log("🛑 Shutting down bot...");
    process.exit();
});
