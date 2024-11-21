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

  try {
    // Echo the message
    await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
      chat_id: chatId,
      text: `You said: ${text}`,
    });
  } catch (error) {
    console.error("Error sending message:", error.response.data);
  }

  res.sendStatus(200);
});

// Endpoint to send custom messages
app.get("/send-message", async (req, res) => {
  const { chatId, text } = req.query;

  if (!chatId || !text) {
    return res.status(400).send("chatId and text are required");
  }

  try {
    const response = await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
      chat_id: chatId,
      text: text,
    });
    res.send(`Message sent: ${response.data.result.text}`);
  } catch (error) {
    console.error(error.response.data);
    res.status(500).send("Failed to send message");
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
