const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });
const axios = require("axios");

const rawToken = process.env.BOT_TOKEN || "";
const BOT_TOKEN = rawToken.replace(/^bot/i, "").replace(/^['"]|['"]$/g, "").trim();
const rawChat = process.env.CHAT_ID || "";
const CHAT_ID = rawChat.replace(/^['"]|['"]$/g, "").trim();

async function sendTelegram(message) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

    await axios.post(url, {
      chat_id: CHAT_ID,
      text: message,
    });

    console.log("✅ Telegram message sent");
  } catch (err) {
    console.error("❌ Telegram Error:");
    console.error(err.response?.data || err.message);
  }
}

module.exports = sendTelegram;