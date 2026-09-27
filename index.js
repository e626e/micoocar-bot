require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");

const token = process.env.BOT_TOKEN;
const adminId = Number(process.env.ADMIN_ID);

if (!token) {
  throw new Error("BOT_TOKEN не найден в .env");
}

if (!adminId) {
  throw new Error("ADMIN_ID не найден в .env");
}

const api = `https://api.telegram.org/bot${token}`;
const carsFile = path.join(__dirname, "cars.json");

// =========================
// FILE STORAGE
// =========================

if (!fs.existsSync(carsFile)) {
  fs.writeFileSync(carsFile, "[]");
}

function readCars() {
  try {
    return JSON.parse(fs.readFileSync(carsFile, "utf8"));
  } catch (error) {
    console.error("Ошибка чтения cars.json:", error);
    return [];
  }
}

function saveCars(cars) {
  fs.writeFileSync(carsFile, JSON.stringify(cars, null, 2));
}

// =========================
// TELEGRAM API
// =========================

async function telegram(method, body = {}) {
  const response = await fetch(`${api}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!data.ok) {
    console.error("Telegram API error:", data);
  }

  return data;
}

// =========================
// EXPRESS API
// =========================

const app = express();

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("MICOOCAR API работает");
});

app.get("/api/cars", (req, res) => {
  try {
    const cars = readCars();

    const publishedCars = cars.filter(
      (car) => car.status === "published"
    );

    res.json(publishedCars);
  } catch (error) {
    console.error("API cars error:", error);

    res.status(500).json({
      error: "Не удалось загрузить автомобили",
    });
  }
});

app.listen(PORT, () => {
  console.log(`MICOOCAR API запущен на порту ${PORT}`);
});

// =========================
// BOT HELPERS
// =========================

async function sendMessage(chatId, text, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    ...extra,
  });
}

function isAdmin(chatId) {
  return Number(chatId) === adminId;
}

// =========================
// BOT COMMANDS
// =========================

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = message.text || "";

  // /myid
  if (text === "/myid") {
    await sendMessage(
      chatId,
      `Ваш Telegram ID: ${chatId}`
    );
    return;
  }

  // /start
  if (text === "/start") {
    await sendMessage(
      chatId,
      "🚗 MICOOCAR\n\nАвтомобили из Китая → Россия",
      {
        reply_markup: {
          keyboard: [
            [{ text: "🚗 Каталог" }],
            [
              { text: "❤️ Избранное" },
              { text: "🧮 Калькулятор" },
            ],
            [
              { text: "📩 Оставить заявку" },
              { text: "👨‍💼 Менеджер" },
            ],
          ],
          resize_keyboard: true,
        },
      }
    );

    return;
  }

  // Каталог
    if (text === "🚗 Каталог") {
    await sendMessage(
      chatId,
      "🚗 Открывайте каталог MICOOCAR:",
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🚗 Открыть каталог",
                url: "https://micoocar.vercel.app",
              },
            ],
          ],
        },
      }
    );

    return;
  }
 

  // Избранное
  if (text === "❤️ Избранное") {
    await sendMessage(
      chatId,
      "❤️ Раздел избранного скоро будет подключён к вашему профилю."
    );
    return;
  }

  // Калькулятор
  if (text === "🧮 Калькулятор") {
    await sendMessage(
      chatId,
      "🧮 Калькулятор стоимости автомобиля скоро будет доступен."
    );
    return;
  }

  // Заявка
  if (text === "📩 Оставить заявку") {
    await sendMessage(
      chatId,
      "📩 Оставьте заявку менеджеру.\n\nНапишите, какой автомобиль вы ищете, и мы свяжемся с вами."
    );
    return;
  }

  // Менеджер
  if (text === "👨‍💼 Менеджер") {
    await sendMessage(
      chatId,
      "👨‍💼 Менеджер MICOOCAR свяжется с вами."
    );
    return;
  }

  // =========================
  // IMPORT FORWARDED CAR
  // =========================

  const isForwarded =
    message.forward_origin ||
    message.forward_from ||
    message.forward_from_chat;

  const hasPhoto =
    Array.isArray(message.photo) &&
    message.photo.length > 0;

  const hasText =
    Boolean(message.text) ||
    Boolean(message.caption);

  if (isAdmin(chatId) && (isForwarded || hasPhoto) && hasText) {
    const sourceMessageId = message.message_id;
    const sourceChatId =
      message.forward_origin?.chat?.id ||
      message.forward_from_chat?.id ||
      chatId;

    const originalText =
      message.caption ||
      message.text ||
      "Текст автомобиля отсутствует";

    const cars = readCars();

    const duplicate = cars.find(
      (car) =>
        String(car.sourceChatId) === String(sourceChatId) &&
        String(car.sourceMessageId) === String(sourceMessageId)
    );

    if (duplicate) {
      await sendMessage(
        chatId,
        "⚠️ Этот автомобиль уже был импортирован."
      );
      return;
    }

    const photo =
      hasPhoto
        ? message.photo[message.photo.length - 1].file_id
        : null;

    const preview =
      `🚗 НОВЫЙ АВТОМОБИЛЬ\n\n` +
      `${originalText}\n\n` +
      `📸 Фото: ${photo ? "получено" : "нет"}\n\n` +
      `Опубликовать автомобиль?`;

    await sendMessage(chatId, preview, {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ Опубликовать",
              callback_data: `publish:${sourceChatId}:${sourceMessageId}`,
            },
            {
              text: "❌ Отмена",
              callback_data: `cancel:${sourceChatId}:${sourceMessageId}`,
            },
          ],
        ],
      },
    });

    return;
  }
}

// =========================
// CALLBACKS
// =========================

async function handleCallback(callback) {
  const chatId = callback.message.chat.id;
  const data = callback.data || "";

  if (!isAdmin(chatId)) {
    return;
  }

  // Publish
  if (data.startsWith("publish:")) {
    const parts = data.split(":");

    const sourceChatId = parts[1];
    const sourceMessageId = parts[2];

    const cars = readCars();

    const existing = cars.find(
      (car) =>
        String(car.sourceChatId) === String(sourceChatId) &&
        String(car.sourceMessageId) === String(sourceMessageId)
    );

    if (existing) {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Этот автомобиль уже опубликован",
      });
      return;
    }

    const text =
      callback.message.text ||
      callback.message.caption ||
      "";

    const car = {
      id: `car_${Date.now()}`,
      sourceChatId,
      sourceMessageId,
      text,
      publishedAt: new Date().toISOString(),
      status: "published",
    };

    cars.push(car);
    saveCars(cars);

    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Автомобиль опубликован!",
    });

    await telegram("editMessageText", {
      chat_id: chatId,
      message_id: callback.message.message_id,
      text: `${text}\n\n✅ АВТОМОБИЛЬ ОПУБЛИКОВАН`,
    });

    console.log(
      `Автомобиль опубликован: ${car.id}`
    );

    return;
  }

  // Cancel
  if (data.startsWith("cancel:")) {
    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Импорт отменён",
    });

    await telegram("editMessageText", {
      chat_id: chatId,
      message_id: callback.message.message_id,
      text: `${callback.message.text}\n\n❌ ИМПОРТ ОТМЕНЁН`,
    });

    return;
  }
}

// =========================
// LONG POLLING
// =========================

let offset = 0;

async function startBot() {
  console.log("MICOOCAR BOT запускается...");

  while (true) {
    try {
      const result = await telegram("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });

      if (!result.ok) {
        await new Promise((resolve) =>
          setTimeout(resolve, 3000)
        );
        continue;
      }

      for (const update of result.result) {
        offset = update.update_id + 1;

        if (update.message) {
          await handleMessage(update.message);
        }

        if (update.callback_query) {
          await handleCallback(update.callback_query);
        }
      }
    } catch (error) {
      console.error("Ошибка бота:", error);

      await new Promise((resolve) =>
        setTimeout(resolve, 3000)
      );
    }
  }
}

console.log("MICOOCAR BOT запущен: @micoocarbot");
console.log(`ADMIN_ID: ${adminId}`);

startBot();
