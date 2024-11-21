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

// Endpoint for Telegram Webhook
app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text;

  // Check if the message is the /start command
  if (text.startsWith("/start")) {
    // Extract the start_param
    const startParam = text.split(" ")[1]; // Gets "index_123_telegram_456"

    // Replace YOUR_WEBAPP_URL with the actual URL of your Telegram WebApp
    const webAppUrl = `https://striking-friendly-mako.ngrok-free.app/?start=${startParam}`;

    try {
      // Send the WebApp link back to the user
      await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
        chat_id: chatId,
        text: `Click the link to open the app: ${webAppUrl}`,
        reply_markup: {
          inline_keyboard: [[{ text: "Open WebApp", url: webAppUrl }]],
        },
      });
    } catch (error) {
      console.error("Error sending message:", error.response.data);
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
