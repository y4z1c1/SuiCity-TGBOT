const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME; // Bot username (without @)
const TELEGRAM_API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

app.use(bodyParser.json());

// In-memory store to track registered users
const registeredUsers = new Set();

/**
 * Helper function to log errors with context.
 */
function logError(context, error) {
  const errorData = error.response?.data || error.message;
  console.error(`Error in ${context}:`, errorData);
}

/**
 * Helper function to send a message and handle errors.
 */
async function sendMessage(chat_id, text) {
  try {
    await axios.post(`${TELEGRAM_API_URL}/sendMessage`, { chat_id, text });
  } catch (error) {
    logError("sendMessage", error);
  }
}

/**
 * Helper function to send a photo and handle errors.
 */
async function sendPhoto(chat_id, photo, caption, reply_markup) {
  try {
    await axios.post(`${TELEGRAM_API_URL}/sendPhoto`, {
      chat_id,
      photo,
      caption,
      reply_markup,
    });
  } catch (error) {
    logError("sendPhoto", error);
    // If chat is invalid or user hasn't started the bot, handle gracefully
    if (error.response?.data?.description === "Bad Request: chat not found") {
      console.error("Chat not found or user has not started the bot.");
    }
    // Optionally, send a fallback text message
    await sendMessage(chat_id, "An error occurred. Please try again later.");
  }
}

/**
 * Send the default welcome message.
 */
async function sendDefaultWelcome(chatId) {
  const welcomePhoto =
    "https://bafybeidade56fa5ljwfxb4wyk46cv3topggduji3rsuabelzzub6ia5s6e.ipfs.w3s.link/telegram-initial-3.webp";
  const welcomeCaption =
    "🎉 Welcome to SuiCityP2E!\nGet ready to explore the ultimate Play-2-Earn experience. 🚀";
  const welcomeMarkup = {
    inline_keyboard: [
      [
        {
          text: "Play",
          url: `https://t.me/${BOT_USERNAME}?startapp=welcome`,
        },
      ],
      [
        { text: "Follow us on Twitter", url: "https://twitter.com/SuiCityP2E" },
        { text: "Join us on Discord", url: "https://discord.gg/nyPMc9xqXG" },
      ],
    ],
  };

  await sendPhoto(chatId, welcomePhoto, welcomeCaption, welcomeMarkup);
}

/**
 * Handle invite start with NFT index.
 */
async function handleInviteStart(chatId, nftIndex, telegramId) {
  const invitePhoto =
    "https://bafybeigeehdqguabym6dwzlr4n4kox7ilrcggqlhjv2g77r3zi2efcgdd4.ipfs.w3s.link/telegram-invite-2.webp";
  const inviteCaption = `SuiCity: Play-2-Earn\n\nYou were invited by SuiCity #${nftIndex}!\nTap the button below to open the app.`;
  const startAppLink = `https://t.me/${BOT_USERNAME}?startapp=${nftIndex}__${telegramId}`;

  const inviteMarkup = {
    inline_keyboard: [
      [
        {
          text: "Use Invite Link",
          url: startAppLink,
        },
      ],
    ],
  };

  await sendPhoto(chatId, invitePhoto, inviteCaption, inviteMarkup);
}

/**
 * Validate and handle the /start command with parameters.
 */
async function handleStartCommand(chatId, text) {
  const startParam = text.split(" ")[1]; // Extract the parameter after "/start"

  if (!startParam) {
    // No invite parameter, send default welcome
    // Only send welcome message once if not registered
    if (!registeredUsers.has(chatId)) {
      registeredUsers.add(chatId);
      await sendDefaultWelcome(chatId);
    } else {
      // User is already registered; you could decide not to resend the welcome
      // or just do nothing here.
    }
    return;
  }

  // Parse parameters: expected format "index_<nftIndex>_telegram_<telegramId>"
  const params = startParam.split("_");
  if (
    params.length === 4 &&
    params[0] === "index" &&
    params[2] === "telegram"
  ) {
    const nftIndex = params[1];
    const telegramId = params[3];
    return handleInviteStart(chatId, nftIndex, telegramId);
  } else {
    // Invalid parameter structure
    await sendMessage(
      chatId,
      "Invalid invite link. Please use a valid invite link to start the game."
    );
  }
}

app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message || !message.chat) {
    console.error("Invalid message structure or missing chat object.");
    return res.sendStatus(200);
  }

  const chatId = message.chat.id;
  const text = message.text;

  if (text && text.startsWith("/start")) {
    try {
      await handleStartCommand(chatId, text);
    } catch (error) {
      logError("handleStartCommand", error);
      await sendMessage(chatId, "An error occurred. Please try again later.");
    }
  }

  // Acknowledge the request from Telegram
  return res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
