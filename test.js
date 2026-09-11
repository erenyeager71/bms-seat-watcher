const sendTelegram = require("./telegram");

(async () => {
  await sendTelegram("🎉 BookMyShow Bot is connected successfully!");
})();