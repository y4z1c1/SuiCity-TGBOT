const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME; // Bot username (without @)
const TELEGRAM_API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Middleware
app.use(bodyParser.json());

// In-memory store to track registered users
const registeredUsers = new Set();

app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text;

  if (text.startsWith("/start")) {
    const startParam = text.split(" ")[1]; // Extract the parameter after "/start"

    try {
      // Send the welcome message only if the user is not already registered
      if (!registeredUsers.has(chatId)) {
        registeredUsers.add(chatId); // Mark the user as registered

        // Combined welcome message with an image
        await axios.post(`${TELEGRAM_API_URL}/sendPhoto`, {
          chat_id: chatId,
          photo: "https://suicityp2e.com/logo.webp", // Replace with your welcome image URL
          caption:
            "🎉 Welcome to SuiCity!\nGet ready to explore the ultimate Play-2-Earn experience. 🚀",
        });
      }

      if (startParam) {
        // Parse the "start" parameter
        const params = startParam.split("_");
        if (
          params.length === 4 &&
          params[0] === "index" &&
          params[2] === "telegram"
        ) {
          const nftIndex = params[1]; // Extract NFT index
          const telegramId = params[3]; // Extract Telegram ID

          const messageText = `SuiCity: Play-2-Earn\n\nYou were invited by NFT #${nftIndex}!\nTap the button below to open the app.`;

          // Generate the startapp link
          const startAppLink = `https://t.me/${BOT_USERNAME}?startapp=${nftIndex}__${telegramId}`;

          // Send an invite message with a different image
          await axios.post(`${TELEGRAM_API_URL}/sendPhoto`, {
            chat_id: chatId,
            photo: "https://suicityp2e.com/invite-image.webp", // Replace with your invite-specific image URL
            caption: messageText,
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "Play",
                    url: startAppLink, // Use startapp link as URL
                  },
                ],
              ],
            },
          });
        } else {
          // Invalid parameter structure
          await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
            chat_id: chatId,
            text: "Invalid invite link. Please use a valid invite link to start the game.",
          });
        }
      } else {
        // No parameter after "/start"
        await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
          chat_id: chatId,
          text: "Welcome to SuiCity! Use a valid invite link to start.",
        });
      }
    } catch (error) {
      console.error("Error handling /start:", error);
      await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
        chat_id: chatId,
        text: "An error occurred. Please try again later.",
      });
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
