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
    const startParam = text.split(" ")[1];

    if (startParam) {
      try {
        const [_, nftIndex, telegramId] = startParam.split("_");

        const messageText = `SuiCity: Play-2-Earn\n\nYou were invited by NFT #${nftIndex} from Telegram ID ${telegramId}!\nTap the button below to open the app.`;

        // Generate the startapp link
        const startAppLink = `https://t.me/${BOT_USERNAME}/appname?startapp=${nftIndex}__${telegramId}`;

        // Send a message with the startapp button
        await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
          chat_id: chatId,
          text: messageText,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Play",
                  url: startAppLink, // Using startapp link as URL
                },
              ],
            ],
          },
        });
      } catch (error) {
        console.error("Error handling /start:", error);
      }
    } else {
      await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
        chat_id: chatId,
        text: "Welcome to SuiCity! Use a valid invite link to start.",
      });
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
