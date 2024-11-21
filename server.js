const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Middleware
app.use(bodyParser.json());

app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text;

  // Check for the /start command
  if (text.startsWith("/start")) {
    // Extract the parameters from the start command
    const startParam = text.split(" ")[1]; // Get everything after "/start"
    const [_, nftIndex, telegramId] = startParam.split("_");

    // Customize the message to the user
    const messageText = `SuiCity: Play-2-Earn\n\nYou were invited by NFT #${nftIndex} from Telegram ID ${telegramId}!\nTap the button below to open the app and join the game.`;

    try {
      // Send a message with a WebApp button, including parameters in the URL
      await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
        chat_id: chatId,
        text: messageText,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Play",
                web_app: {
                  url: `https://striking-friendly-mako.ngrok-free.app/?nftIndex=${nftIndex}&telegramId=${telegramId}`, // Include parameters here
                },
              },
            ],
          ],
        },
      });
    } catch (error) {
      console.error("Error sending WebApp button:", error.response.data);
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
