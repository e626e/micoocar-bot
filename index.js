require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "20kb" }));
const token = process.env.BOT_TOKEN;
const adminId = Number(process.env.ADMIN_ID);

if (!token) {
  throw new Error("BOT_TOKEN не найден в Environment Variables");
}

if (!adminId) {
  throw new Error("ADMIN_ID не найден в .env");
}

const api = `https://api.telegram.org/bot${token}`;
const carsFile = path.join(__dirname, "cars.json");

// =========================
// FILE STORAGE + GITHUB
// =========================

if (!fs.existsSync(carsFile)) {
  fs.writeFileSync(carsFile, "[]");
}

const githubToken = process.env.GITHUB_TOKEN;
const githubOwner = process.env.GITHUB_OWNER;
const githubRepo = process.env.GITHUB_REPO;
const githubFilePath = "cars.json";

async function syncCarsFromGitHub() {
  if (!githubToken || !githubOwner || !githubRepo) {
    console.log("GitHub storage не настроен. Используется локальный cars.json.");
    return;
  }

  try {
    const url =
      `https://api.github.com/repos/${githubOwner}/${githubRepo}/contents/${githubFilePath}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub GET error: ${response.status}`);
    }

    const data = await response.json();

    if (!data.content) {
      throw new Error("GitHub cars.json не содержит content");
    }

    const content = Buffer.from(
      data.content.replace(/\n/g, ""),
      "base64"
    ).toString("utf8");

    fs.writeFileSync(carsFile, content);

    console.log("✅ cars.json загружен из GitHub");
  } catch (error) {
    console.error("Ошибка загрузки cars.json из GitHub:", error);
  }
}

function readCars() {
  try {
    return JSON.parse(fs.readFileSync(carsFile, "utf8"));
  } catch (error) {
    console.error("Ошибка чтения cars.json:", error);
    return [];
  }
}

async function saveCars(cars) {
  const content = JSON.stringify(cars, null, 2);

  // Сохраняем локально
  fs.writeFileSync(carsFile, content);

  if (!githubToken || !githubOwner || !githubRepo) {
    return;
  }

  try {
    const url =
      `https://api.github.com/repos/${githubOwner}/${githubRepo}/contents/${githubFilePath}`;

    // Получаем текущий SHA файла
    const getResponse = await fetch(url, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!getResponse.ok) {
      throw new Error(`GitHub GET error: ${getResponse.status}`);
    }

    const fileData = await getResponse.json();

    const putResponse = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "Update cars.json",
        content: Buffer.from(content).toString("base64"),
        sha: fileData.sha,
      }),
    });

    if (!putResponse.ok) {
      const errorText = await putResponse.text();
      throw new Error(
        `GitHub PUT error: ${putResponse.status} ${errorText}`
      );
    }

    console.log("✅ cars.json сохранён в GitHub");
  } catch (error) {
    console.error("Ошибка сохранения cars.json в GitHub:", error);
  }
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

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("MICOOCAR API работает");
});

async function sendCarPhoto(req, res, photoIndex = 0) {
  try {
    const cars = readCars();

    const car = cars.find(
      item => String(item.id) === String(req.params.id)
    );

    if (!car) {
      return res.status(404).send("Автомобиль не найден");
    }

    // Поддержка новых и старых карточек
    const photos =
      Array.isArray(car.photos) && car.photos.length
        ? car.photos
        : car.photo
          ? [car.photo]
          : [];

    const fileId = photos[photoIndex];

    if (!fileId) {
      return res.status(404).send("Фото не найдено");
    }

    const fileResult = await telegram("getFile", {
      file_id: fileId,
    });

    const filePath = fileResult?.result?.file_path;

    if (!filePath) {
      return res.status(404).send("Файл Telegram не найден");
    }

    const imageUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const response = await fetch(imageUrl);

    if (!response.ok) {
      return res.status(502).send("Не удалось получить фото");
    }

    const contentType =
      response.headers.get("content-type") || "image/jpeg";

    const buffer = Buffer.from(await response.arrayBuffer());

    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buffer);
  } catch (error) {
    console.error("Ошибка получения фото:", error);
    res.status(500).send("Ошибка сервера");
  }
}

// Старый адрес первого фото сохраняем
app.get("/api/cars/:id/photo", (req, res) => {
  sendCarPhoto(req, res, 0);
});

// Получение конкретного фото из галереи
app.get("/api/cars/:id/photos/:index", (req, res) => {
  const index = Number(req.params.index);

  if (!Number.isInteger(index) || index < 0) {
    return res.status(400).send("Неверный номер фотографии");
  }

  sendCarPhoto(req, res, index);
});

// Каталог автомобилей
app.get("/api/cars", (req, res) => {
  try {
    const cars = readCars();

    const publishedCars = cars.filter(
      car => car.status === "published"
    );

    res.json(
      publishedCars.map(car => {
        const photoCount =
          Array.isArray(car.photos) && car.photos.length
            ? car.photos.length
            : car.photo
              ? 1
              : 0;

        return {
          ...car,
          description: car.description || car.text || "",
          photos: Array.from(
            { length: photoCount },
            (_, index) =>
              `/api/cars/${encodeURIComponent(car.id)}/photos/${index}`
          ),
        };
      })
    );
  } catch (error) {
    console.error("API cars error:", error);

    res.status(500).json({
      error: "Не удалось загрузить автомобили",
    });
  }
});


// Заявки из MICOOR CAR Mini App
app.post("/api/leads", async (req, res) => {
  try {
    const {
      carId,
      brand,
      model,
      price,
      vin,
      phone,
      userId,
      username,
      firstName,
      lastName,
    } = req.body || {};

    const phoneValue = String(phone || "").trim();
    const phoneDigits = phoneValue.replace(/\D/g, "");

    if (phoneDigits.length < 7 || phoneDigits.length > 15) {
      return res.status(400).json({
        success: false,
        error: "Укажите корректный номер телефона",
      });
    }

    const clientName =
      [firstName, lastName].filter(Boolean).join(" ") || "Не указано";

    const cleanUsername = String(username || "")
      .replace(/^@/, "")
      .trim();

    const validUsername = /^[A-Za-z0-9_]{5,32}$/.test(cleanUsername);
    const clientTelegram = validUsername
      ? `@${cleanUsername}`
      : "username не указан";

    const message = [
      "🔥 НОВАЯ ЗАЯВКА MICOOR CAR",
      "",
      "🚗 АВТОМОБИЛЬ",
      `Марка и модель: ${[brand, model].filter(Boolean).join(" ") || "Не указано"}`,
      `Цена: ${price || "Не указана"}`,
      `VIN: ${vin || "Не указан"}`,
      `ID автомобиля: ${carId || "—"}`,
      "",
      "👤 КЛИЕНТ",
      `Телефон: ${phoneValue}`,
      `Имя: ${clientName}`,
      `Telegram: ${clientTelegram}`,
      `Telegram ID: ${userId || "не передан"}`,
    ].join("\n");

    const extra = validUsername
      ? {
          reply_markup: {
            inline_keyboard: [[
              {
                text: "Открыть Telegram клиента",
                url: `https://t.me/${cleanUsername}`,
              },
            ]],
          },
        }
      : {};

    const result = await sendMessage(-1004356831309, message, extra);

    if (!result || !result.ok) {
      console.error("Не удалось отправить заявку в группу лидов:", result);
      return res.status(502).json({
        success: false,
        error: "Не удалось доставить заявку менеджеру",
      });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("Ошибка API leads:", error);
    return res.status(500).json({
      success: false,
      error: "Не удалось обработать заявку",
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
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
// TELEGRAM ALBUM COLLECTOR
// =========================

const pendingAlbums = new Map();
const pendingCarDescriptions = new Map();

function getLargestPhoto(message) {
  if (!Array.isArray(message.photo) || !message.photo.length) {
    return null;
  }

  return message.photo[message.photo.length - 1].file_id;
}

async function saveImportedCar(chatId, messages, descriptionOverride = '') {
  const sortedMessages = [...messages].sort(
    (a, b) => a.message_id - b.message_id
  );

  const firstMessage = sortedMessages[0];

  const sourceChatId =
    firstMessage.forward_origin?.chat?.id ||
    firstMessage.forward_from_chat?.id ||
    chatId;

  const sourceMessageId = firstMessage.message_id;

  const textMessage = sortedMessages.find(
    message => message.caption || message.text
  );

  const embeddedText = String(
    textMessage?.caption || textMessage?.text || ""
  ).trim();

  const isPlaceholder =
    !embeddedText ||
    /Текст автомобиля отсутствует|📝\s*Текст:\s*нет/i.test(embeddedText);

  const originalText = String(
    descriptionOverride || (isPlaceholder ? "" : embeddedText)
  ).trim();

  if (!originalText) {
    const key = String(chatId);

    if (pendingCarDescriptions.has(key)) {
      await sendMessage(
        chatId,
        "⚠️ Предыдущее объявление ещё ждёт описание. Сначала отправьте его текст или /cancel, затем повторно отправьте новый альбом."
      );
      return;
    }

    pendingCarDescriptions.set(key, sortedMessages);

    const photoCount = sortedMessages.map(getLargestPhoto).filter(Boolean).length;

    await sendMessage(
      chatId,
      `📸 Получено фотографий: ${photoCount}.\n\nТеперь отправьте следующим сообщением полный текст этого объявления. Я объединю его со всеми фотографиями в одну карточку.\n\nДля отмены напишите /cancel.`
    );
    return;
  }

  const photos = sortedMessages
    .map(getLargestPhoto)
    .filter(Boolean);

  const cars = readCars();

  const duplicate = cars.find(
    car =>
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

  const pendingCar = {
    id: `car_${Date.now()}`,
    sourceChatId,
    sourceMessageId,
    text: originalText,
    description: originalText,
    photo: photos[0] || null,
    photos,
    publishedAt: new Date().toISOString(),
    status: "pending",
  };

  cars.push(pendingCar);

  await saveCars(cars);

  const preview =
    `🚗 НОВЫЙ АВТОМОБИЛЬ\n\n` +
    `${originalText}\n\n` +
    `📸 Фотографий: ${photos.length}\n\n` +
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
}

function queueAlbumMessage(message) {
  const chatId = message.chat.id;
  const key = `${chatId}:${message.media_group_id}`;

  let album = pendingAlbums.get(key);

  if (!album) {
    album = {
      chatId,
      messages: [],
      timer: null,
    };

    pendingAlbums.set(key, album);
  }

  album.messages.push(message);

  if (album.timer) {
    clearTimeout(album.timer);
  }

  // Ждём поступления всех фотографий альбома
  album.timer = setTimeout(async () => {
    pendingAlbums.delete(key);

    try {
      await saveImportedCar(album.chatId, album.messages);
    } catch (error) {
      console.error("Ошибка импорта альбома:", error);

      await sendMessage(
        album.chatId,
        "❌ Не удалось импортировать альбом."
      );
    }
  }, 1800);
}

// =========================
// BOT COMMANDS
// =========================

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = message.text || "";

  // Описание автомобиля, ожидающее после импорта альбома
  if (isAdmin(chatId) && pendingCarDescriptions.has(String(chatId)) && message.text) {
    const description = message.text.trim();

    if (description.toLowerCase() === "/cancel") {
      pendingCarDescriptions.delete(String(chatId));
      await sendMessage(chatId, "Импорт альбома отменён. Автомобиль не сохранён.");
      return;
    }

    if (description && !description.startsWith("/")) {
      const pendingMessages = pendingCarDescriptions.get(String(chatId));
      pendingCarDescriptions.delete(String(chatId));

      try {
        await saveImportedCar(chatId, pendingMessages, description);
      } catch (error) {
        console.error("Ошибка сохранения описания автомобиля:", error);
        await sendMessage(chatId, "❌ Не удалось сохранить объявление. Попробуйте импортировать альбом заново.");
      }
      return;
    }
  }


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

  // Альбом: собираем все фотографии в одну карточку
  if (isAdmin(chatId) && message.media_group_id && hasPhoto) {
    queueAlbumMessage(message);
    return;
  }

  // Обычная публикация или одиночное фото
  if (isAdmin(chatId) && (isForwarded || hasPhoto) && hasText) {
    await saveImportedCar(chatId, [message]);
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

    const car = cars.find(
      item =>
        String(item.sourceChatId) === String(sourceChatId) &&
        String(item.sourceMessageId) === String(sourceMessageId)
    );

    if (!car) {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Автомобиль не найден",
      });
      return;
    }

    if (car.status === "published") {
      await telegram("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "Этот автомобиль уже опубликован",
      });
      return;
    }

    car.status = "published";
    car.publishedAt = new Date().toISOString();

    await saveCars(cars);

    await telegram("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Автомобиль опубликован!",
    });

    await telegram("editMessageText", {
      chat_id: chatId,
      message_id: callback.message.message_id,
      text: `${callback.message.text}\n\n✅ АВТОМОБИЛЬ ОПУБЛИКОВАН`,
    });

    console.log(`Автомобиль опубликован: ${car.id}`);

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
        await new Promise(resolve => setTimeout(resolve, 3000));
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

      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

console.log("MICOOCAR BOT запущен: @micoocarbot");
console.log(`ADMIN_ID: ${adminId}`);

(async () => {
  await syncCarsFromGitHub();
  await startBot();
})();