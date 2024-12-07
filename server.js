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
  if (!message || !message.chat) {
    console.error("Invalid message structure or missing chat object.");
    return res.sendStatus(200); // Acknowledge with no further processing
  }

  const chatId = message.chat.id;
  const text = message.text;

  if (text && text.startsWith("/start")) {
    const startParam = text.split(" ")[1]; // Extract the parameter after "/start"

    try {
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

          const messageText = `SuiCity: Play-2-Earn\n\nYou were invited by SuiCity #${nftIndex}!\nTap the button below to open the app.`;

          const startAppLink = `https://t.me/${BOT_USERNAME}?startapp=${nftIndex}__${telegramId}`;

          // Send an invite message with a different image
          await axios.post(`${TELEGRAM_API_URL}/sendPhoto`, {
            chat_id: chatId,
            photo:
              "https://bafybeigeehdqguabym6dwzlr4n4kox7ilrcggqlhjv2g77r3zi2efcgdd4.ipfs.w3s.link/telegram-invite-2.webp", // Replace with your invite-specific image URL
            caption: messageText,
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "Use Invite Link",
                    url: startAppLink, // Use startapp link as URL
                  },
                ],
              ],
            },
          });

          return res.sendStatus(200); // Stop further processing
        } else {
          // Invalid parameter structure
          await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
            chat_id: chatId,
            text: "Invalid invite link. Please use a valid invite link to start the game.",
          });
          return res.sendStatus(200); // Stop further processing
        }
      } else {
        await axios.post(`${TELEGRAM_API_URL}/sendPhoto`, {
          chat_id: chatId,
          photo:
            "https://bafybeidade56fa5ljwfxb4wyk46cv3topggduji3rsuabelzzub6ia5s6e.ipfs.w3s.link/telegram-initial-3.webp", // Replace with your welcome image URL
          caption:
            "🎉 Welcome to SuiCityP2E!\nGet ready to explore the ultimate Play-2-Earn experience. 🚀",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Play",
                  url: `https://t.me/${BOT_USERNAME}?startapp=welcome`, // Replace with your app's generic link
                },
              ],
              [
                {
                  text: "Follow us on Twitter",
                  url: "https://twitter.com/SuiCityP2E", // Replace with your Twitter link
                },
                {
                  text: "Join us on Discord",
                  url: "https://discord.gg/nyPMc9xqXG", // Replace with your Discord link
                },
              ],
            ],
          },
        });
      }

      // Send the default welcome message only if no invite parameter is present
      if (!registeredUsers.has(chatId)) {
        registeredUsers.add(chatId); // Mark the user as registered

        await axios.post(`${TELEGRAM_API_URL}/sendPhoto`, {
          chat_id: chatId,
          photo:
            "https://bafybeidade56fa5ljwfxb4wyk46cv3topggduji3rsuabelzzub6ia5s6e.ipfs.w3s.link/telegram-initial-3.webp", // Replace with your welcome image URL
          caption:
            "🎉 Welcome to SuiCityP2E!\nGet ready to explore the ultimate Play-2-Earn experience. 🚀",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Play",
                  url: `https://t.me/${BOT_USERNAME}?startapp=welcome`, // Replace with your app's generic link
                },
              ],
              [
                {
                  text: "Follow us on Twitter",
                  url: "https://twitter.com/SuiCityP2E", // Replace with your Twitter link
                },
                {
                  text: "Join us on Discord",
                  url: "https://discord.gg/nyPMc9xqXG", // Replace with your Discord link
                },
              ],
            ],
          },
        });
      }
    } catch (error) {
      console.error(
        "Error handling /start command:",
        error.response?.data || error.message
      );

      if (error.response?.data?.description === "Bad Request: chat not found") {
        console.error(
          "The chat_id is invalid or the user has not started the bot."
        );
      }

      await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
        chat_id: chatId,
        text: "An error occurred. Please try again later.",
      });
    }
  }

  res.sendStatus(200); // Acknowledge webhook
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
