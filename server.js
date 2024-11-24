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

app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text;

  if (text.startsWith("/start")) {
    const startParam = text.split(" ")[1]; // Extract the parameter after "/start"

    if (startParam) {
      try {
        // Parse the "start" parameter
        const params = startParam.split("_");
        if (
          params.length === 4 &&
          params[0] === "index" &&
          params[2] === "telegram"
        ) {
          const nftIndex = params[1]; // Extract NFT index
          const telegramId = params[3]; // Extract Telegram ID

          const messageText = `SuiCity: Play-2-Earn\n\nYou were invited by NFT #${nftIndex} from Telegram ID ${telegramId}!\nTap the button below to open the app.`;

          // Generate the startapp link
          const startAppLink = `https://t.me/${BOT_USERNAME}?startapp=${nftIndex}__${telegramId}`;

          // Send a message with the startapp button
          await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
            chat_id: chatId,
            text: messageText,
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
      } catch (error) {
        console.error("Error handling /start:", error);
        await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
          chat_id: chatId,
          text: "An error occurred. Please try again later.",
        });
      }
    } else {
      // No parameter after "/start"
      await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
        chat_id: chatId,
        text: "Welcome to SuiCity! Use a valid invite link to start.",
      });
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
