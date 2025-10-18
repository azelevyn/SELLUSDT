// Import necessary libraries
const TelegramBot = require('node-telegram-bot-api');
const CoinPayments = require('coinpayments');
require('dotenv').config();

// --- CONFIGURATION ---
// Retrieve sensitive information from environment variables
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const merchantId = process.env.COINPAYMENTS_MERCHANT_ID;
const publicKey = process.env.COINPAYMENTS_PUBLIC_KEY;
const privateKey = process.env.COINPAYMENTS_PRIVATE_KEY;
const buyerRefundEmail = process.env.BUYER_REFUND_EMAIL;

// Check for missing essential configuration
if (!botToken || !merchantId || !publicKey || !privateKey || !buyerRefundEmail) {
    console.error("CRITICAL ERROR: Missing one or more required environment variables. Please check your .env file.");
    process.exit(1);
}

// Initialize the Telegram Bot
const bot = new TelegramBot(botToken, { polling: true });

// Initialize CoinPayments client
let coinpayments;
try {
    coinpayments = new CoinPayments({
        key: publicKey,
        secret: privateKey,
    });
    console.log("CoinPayments client initialized successfully.");
} catch (error) {
    console.error("Failed to initialize CoinPayments client:", error.message);
    process.exit(1);
}


// --- BOT DATA AND STATE MANAGEMENT ---
// In-memory storage for user states during the transaction process.
// For production, consider a more persistent storage like a database (e.g., Redis, Firestore).
const userStates = {};

// Exchange Rates (can be updated dynamically from an API in a real application)
const exchangeRates = {
    'USD': 0.89, // 1 USD to EUR
    'GBP': 0.77, // 1 USDT to GBP
    'USDT': 1.08, // 1 USD to USDT (This seems inverted, usually it's 1 USDT to USD. Assuming 1 USDT = 1.08 USD for this logic)
};

// --- HELPER FUNCTIONS ---
/**
 * Resets a user's state, clearing any stored data.
 * @param {number} userId The Telegram user ID.
 */
const resetUserState = (userId) => {
    delete userStates[userId];
    console.log(`State reset for user ${userId}`);
};

/**
 * Generates a summary of the user's choices before creating the transaction.
 * @param {object} state The user's current state object.
 * @returns {string} A formatted summary string.
 */
const getTransactionSummary = (state) => {
    const receiveAmount = (state.amount / exchangeRates.USDT).toFixed(2); // Example calculation
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
};


// --- BOT COMMANDS AND MESSAGE HANDLERS ---

// Handler for the /start command
bot.onText(/\/start/, (msg) => {
    const userId = msg.chat.id;
    const firstName = msg.from.first_name || '';
    const lastName = msg.from.last_name || '';

    resetUserState(userId); // Ensure a clean state on start

    const welcomeMessage = `
Hello ${firstName} ${lastName},

Welcome to the USDT Selling Bot.
My purpose is to help you securely and efficiently sell your USDT for various fiat currencies.

Please use the 'MENU' button below to begin the process.
    `;

    bot.sendMessage(userId, welcomeMessage, {
        reply_markup: {
            keyboard: [
                [{ text: 'MENU' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: true
        }
    });
});

// Handler for the "MENU" button
bot.onText(/MENU/, (msg) => {
    const userId = msg.chat.id;
    userStates[userId] = { step: 'start' }; // Initialize state

    bot.sendMessage(userId, 'Do you want to sell USDT?', {
        reply_markup: {
            inline_keyboard: [
                [{ text: 'YES', callback_data: 'sell_usdt_yes' }],
                [{ text: 'NO', callback_data: 'sell_usdt_no' }]
            ]
        }
    });
});


// Handler for all text messages to capture user input based on their state
bot.on('message', (msg) => {
    const userId = msg.chat.id;
    const userState = userStates[userId];

    // Ignore commands or menu button presses handled by other listeners
    if (msg.text.startsWith('/') || msg.text === 'MENU') {
        return;
    }

    if (!userState || !userState.step) {
        return; // Do nothing if the user is not in a specific process
    }

    // Capture payment details
    if (userState.step === 'awaiting_payment_details') {
        userState.paymentDetails = msg.text;
        userState.step = 'awaiting_amount';
        bot.sendMessage(userId, 'Thank you. Now, please enter the amount of USDT you wish to sell (Min: 25, Max: 50,000).');
    }
    // Capture amount and create transaction
    else if (userState.step === 'awaiting_amount') {
        const amount = parseFloat(msg.text);

        if (isNaN(amount) || amount < 25 || amount > 50000) {
            bot.sendMessage(userId, 'Invalid amount. Please enter a number between 25 and 50,000.');
            return;
        }

        userState.amount = amount;
        userState.step = 'confirm_transaction';

        const summary = getTransactionSummary(userState);
        bot.sendMessage(userId, summary, {
             parse_mode: 'Markdown',
             reply_markup: {
                inline_keyboard: [
                    [{ text: 'Confirm & Get Deposit Address', callback_data: 'confirm_transaction' }],
                    [{ text: 'Cancel', callback_data: 'cancel_transaction' }]
                ]
            }
        });
    }
});


// --- CALLBACK QUERY HANDLER (for inline buttons) ---

bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const userId = msg.chat.id;
    const data = callbackQuery.data;

    // Acknowledge the callback
    bot.answerCallbackQuery(callbackQuery.id);

    // Ensure user state exists
    if (!userStates[userId]) {
        userStates[userId] = { step: 'start' };
    }
    const userState = userStates[userId];


    // --- Flow Logic ---

    if (data === 'sell_usdt_yes') {
        userState.step = 'select_currency';
        const ratesText = `
Current Exchange Rates:
- 1 USD = ${exchangeRates.USD} EUR
- 1 USDT = ${exchangeRates.GBP} GBP
- 1 USDT = ${exchangeRates.USDT} USD
        `;
        bot.sendMessage(userId, `${ratesText}\n\nPlease select your preferred fiat currency:`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'USD', callback_data: 'currency_USD' }, { text: 'EUR', callback_data: 'currency_EUR' }, { text: 'GBP', callback_data: 'currency_GBP' }]
                ]
            }
        });
    } else if (data === 'sell_usdt_no' || data === 'cancel_transaction') {
        bot.sendMessage(userId, 'Transaction cancelled. Thank you for using the bot. Press /start to begin again.');
        resetUserState(userId);
    } else if (data.startsWith('currency_')) {
        userState.currency = data.split('_')[1];
        userState.step = 'select_network';
        bot.sendMessage(userId, 'Please select the deposit network:', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'USDT TRC20', callback_data: 'network_USDT.TRC20' }],
                    [{ text: 'USDT ERC20', callback_data: 'network_USDT.ERC20' }]
                ]
            }
        });
    } else if (data.startsWith('network_')) {
        userState.network = data.split('_')[1];
        userState.step = 'select_payment_method';
        bot.sendMessage(userId, 'Please select your preferred payment method:', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Wise', callback_data: 'payment_Wise' }, { text: 'Revolut', callback_data: 'payment_Revolut' }],
                    [{ text: 'PayPal', callback_data: 'payment_PayPal' }, { text: 'Bank Transfer', callback_data: 'payment_Bank' }],
                    [{ text: 'Skrill/Neteller', callback_data: 'payment_Skrill' }, { text: 'Visa/Mastercard', callback_data: 'payment_Card' }],
                    [{ text: 'Payeer', callback_data: 'payment_Payeer' }, { text: 'Alipay', callback_data: 'payment_Alipay' }]
                ]
            }
        });
    } else if (data.startsWith('payment_')) {
        const method = data.split('_')[1];
        userState.paymentMethod = method;
        userState.step = 'awaiting_payment_details';

        let prompt = '';
        switch (method) {
            case 'Wise': prompt = 'Please enter your Wise email or tag:'; break;
            case 'Revolut': prompt = 'Please enter your Revolut revtag:'; break;
            case 'PayPal': prompt = 'Please enter your PayPal email:'; break;
            case 'Bank': prompt = 'Please provide your full IBAN details (Name, IBAN, SWIFT/BIC, Bank Name, Country):'; break;
            case 'Skrill': prompt = 'Please enter your Skrill or Neteller email:'; break;
            case 'Card': prompt = 'Please enter your Visa/Mastercard number:'; break;
            case 'Payeer': prompt = 'Please enter your Payeer account number:'; break;
            case 'Alipay': prompt = 'Please enter your Alipay email:'; break;
        }
        bot.sendMessage(userId, prompt);
    } else if (data === 'confirm_transaction') {
        bot.sendMessage(userId, 'Processing your request... Please wait.');

        const transactionOptions = {
            currency1: 'USDT',
            currency2: userState.network, // This tells CoinPayments which network to generate an address for
            amount: userState.amount,
            buyer_email: buyerRefundEmail,
            custom: JSON.stringify({ // Store user data for fulfillment
                telegramId: userId,
                fiat: userState.currency,
                method: userState.paymentMethod,
                details: userState.paymentDetails
            }),
            ipn_url: '', // Add your webhook URL here for production
        };

        try {
            const result = await coinpayments.createTransaction(transactionOptions);
            
            const depositMessage = `
**Your deposit has been created!**

To complete the transaction, please send exactly **${result.amount} USDT** to the following address:

**Address:**
\`${result.address}\`

**Status URL:** [Click to view](${result.status_url})

Your fiat payment will be processed once the deposit is confirmed on the blockchain. This may take a few minutes.
            `;

            bot.sendMessage(userId, depositMessage, { parse_mode: 'Markdown' });
            // Optionally send the QR code
            if (result.qrcode_url) {
                bot.sendPhoto(userId, result.qrcode_url, { caption: 'You can also scan this QR code to send the payment.' });
            }
            resetUserState(userId); // Clear state after successful initiation

        } catch (error) {
            console.error(`CoinPayments API Error for user ${userId}:`, error.message);
            bot.sendMessage(userId, 'Sorry, an error occurred while creating your transaction. Please try again later.');
            resetUserState(userId);
        }
    }
});


// --- BOT STARTUP AND ERROR HANDLING ---
console.log('Bot is running...');

// Graceful shutdown
process.on('SIGINT', () => {
    console.log("Shutting down bot...");
    process.exit();
});
process.on('SIGTERM', () => {
    console.log("Shutting down bot...");
    process.exit();
});
