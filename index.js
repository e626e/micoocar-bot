require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");

// =========================
// CONFIG
// =========================

const token = process.env.BOT_TOKEN;
const adminId = Number(process.env.ADMIN_ID);

if (!token) {
  throw new Error("BOT_TOKEN не найден в Environment Variables");
}

if (!adminId) {
  throw new Error("ADMIN_ID не найден в .env");
}

// Дополнительные админы через запятую: ADMIN_IDS=111,222
const adminIds = new Set(
  [adminId, ...String(process.env.ADMIN_IDS || "").split(",")]
    .map(value => Number(String(value).trim()))
    .filter(Boolean)
);

// ID канала (-100...) или @username. Если не указан — бот принимает посты
// из любого канала, где он админ, и сообщает его ID администратору.
const channelFilter = String(process.env.CHANNEL_ID || "").trim();

const leadsChatId = process.env.LEADS_CHAT_ID || "-1004356831309";
const miniAppUrl = process.env.MINIAPP_URL || "https://micoocar.vercel.app";
const publicUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || "";

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
const githubEnabled = Boolean(githubToken && githubOwner && githubRepo);

function githubUrl(file = githubFilePath) {
  return `https://api.github.com/repos/${githubOwner}/${githubRepo}/contents/${file}`;
}

function githubHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...extra,
  };
}

async function syncFileFromGitHub(file, localPath) {
  if (!githubEnabled) {
    console.log(`GitHub storage не настроен. Используется локальный ${file}.`);
    return;
  }

  try {
    const response = await fetch(githubUrl(file), { headers: githubHeaders() });

    if (response.status === 404) {
      console.log(`${file} в GitHub ещё нет — будет создан`);
      return;
    }

    if (!response.ok) {
      throw new Error(`GitHub GET error: ${response.status}`);
    }

    const data = await response.json();

    if (!data.content) {
      throw new Error(`GitHub ${file} не содержит content`);
    }

    const content = Buffer.from(
      data.content.replace(/\n/g, ""),
      "base64"
    ).toString("utf8");

    JSON.parse(content); // проверяем, что файл не повреждён
    fs.writeFileSync(localPath, content);

    console.log(`✅ ${file} загружен из GitHub`);
  } catch (error) {
    console.error(`Ошибка загрузки ${file} из GitHub:`, error);
  }
}

function syncCarsFromGitHub() {
  return syncFileFromGitHub(githubFilePath, carsFile);
}

function readCars() {
  try {
    const cars = JSON.parse(fs.readFileSync(carsFile, "utf8"));
    return Array.isArray(cars) ? cars : [];
  } catch (error) {
    console.error("Ошибка чтения cars.json:", error);
    return [];
  }
}

async function pushFileToGitHub(file, localPath) {
  if (!githubEnabled) return;

  // Всегда отправляем самую свежую версию файла
  const content = fs.readFileSync(localPath, "utf8");

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const getResponse = await fetch(githubUrl(file), { headers: githubHeaders() });

      if (!getResponse.ok && getResponse.status !== 404) {
        throw new Error(`GitHub GET error: ${getResponse.status}`);
      }

      const fileData = getResponse.ok ? await getResponse.json() : {};

      // [skip render] — сохранение данных не должно перезапускать сервер на Render
      const putResponse = await fetch(githubUrl(file), {
        method: "PUT",
        headers: githubHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          message: `Update ${file} [skip render]`,
          content: Buffer.from(content).toString("base64"),
          ...(fileData.sha ? { sha: fileData.sha } : {}),
        }),
      });

      if (!putResponse.ok) {
        const errorText = await putResponse.text();
        throw new Error(`GitHub PUT error: ${putResponse.status} ${errorText}`);
      }

      console.log(`✅ ${file} сохранён в GitHub`);
      return;
    } catch (error) {
      console.error(`Ошибка сохранения в GitHub (попытка ${attempt}):`, error.message);
      await sleep(1500 * attempt);
    }
  }
}

// Сохранения в GitHub выполняются строго по очереди,
// чтобы несколько авто подряд не перезаписали друг друга.
let githubQueue = Promise.resolve();

function saveCars(cars) {
  fs.writeFileSync(carsFile, JSON.stringify(cars, null, 2));
  githubQueue = githubQueue.then(() => pushFileToGitHub(githubFilePath, carsFile)).catch(() => {});
  return githubQueue;
}

// =========================
// СТАТИСТИКА ПРОСМОТРОВ
// =========================

const statsFile = path.join(__dirname, "stats.json");
let stats = { cars: {}, days: {} };
let statsDirty = false;
const recentViews = new Map();

function loadStats() {
  try {
    const data = JSON.parse(fs.readFileSync(statsFile, "utf8"));
    stats = { cars: data.cars || {}, days: data.days || {} };
  } catch {
    stats = { cars: {}, days: {} };
  }
}

// День по времени Владивостока (UTC+10)
function statsDay(offsetDays = 0) {
  return new Date(Date.now() + 10 * 3600e3 - offsetDays * 86400e3).toISOString().slice(0, 10);
}

function carStats(carId) {
  const key = String(carId);
  if (!stats.cars[key]) stats.cars[key] = { views: 0, viewers: [], leads: 0 };
  return stats.cars[key];
}

function dayStats(day = statsDay()) {
  if (!stats.days[day]) stats.days[day] = { views: 0, leads: 0, wishes: 0 };
  return stats.days[day];
}

function trackView(carId, viewerKey) {
  const throttleKey = `${carId}:${viewerKey}`;
  const last = recentViews.get(throttleKey) || 0;

  // Один и тот же человек засчитывается не чаще раза в 30 минут
  if (Date.now() - last < 30 * 60 * 1000) return false;
  recentViews.set(throttleKey, Date.now());

  const item = carStats(carId);
  item.views += 1;
  item.lastViewAt = new Date().toISOString();

  if (viewerKey && !item.viewers.includes(viewerKey)) {
    item.viewers.push(viewerKey);
    if (item.viewers.length > 5000) item.viewers.shift();
  }

  dayStats().views += 1;
  statsDirty = true;
  return true;
}

function trackLead(carId, kind = "leads") {
  if (carId && kind === "leads") carStats(carId).leads += 1;
  dayStats()[kind] = (dayStats()[kind] || 0) + 1;
  statsDirty = true;
}

function publicStats(carId) {
  const item = stats.cars[String(carId)] || { views: 0, viewers: [], leads: 0 };
  return {
    views: item.views || 0,
    uniqueViews: (item.viewers || []).length,
    leads: item.leads || 0,
    lastViewAt: item.lastViewAt || null,
  };
}

function statsSummary() {
  const sum = (days, key) =>
    Array.from({ length: days }, (_, index) => stats.days[statsDay(index)]?.[key] || 0)
      .reduce((total, value) => total + value, 0);

  return {
    todayViews: sum(1, "views"),
    weekViews: sum(7, "views"),
    weekLeads: sum(7, "leads") + sum(7, "wishes"),
    totalViews: Object.values(stats.cars).reduce((total, item) => total + (item.views || 0), 0),
  };
}

function saveStats() {
  // Храним не больше 120 дней истории
  Object.keys(stats.days)
    .sort()
    .slice(0, -120)
    .forEach(day => delete stats.days[day]);

  fs.writeFileSync(statsFile, JSON.stringify(stats));
  statsDirty = false;
  githubQueue = githubQueue.then(() => pushFileToGitHub("stats.json", statsFile)).catch(() => {});
  return githubQueue;
}

loadStats();

if (require.main === module) {
  // Статистика копится в памяти и сохраняется раз в 20 минут
  setInterval(() => {
    if (statsDirty) saveStats();
  }, 20 * 60 * 1000);

  // Перед перезапуском сервера сохраняем накопленное
  process.on("SIGTERM", async () => {
    try {
      if (statsDirty) await Promise.race([saveStats(), sleep(8000)]);
    } finally {
      process.exit(0);
    }
  });
}

// =========================
// HELPERS
// =========================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function telegram(method, body = {}) {
  const response = await fetch(`${api}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!data.ok) {
    console.error(`Telegram API error (${method}):`, data.description || data);
  }

  return data;
}

async function sendMessage(chatId, text, extra = {}) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    ...extra,
  });
}

async function notifyAdmins(text, extra = {}) {
  for (const id of adminIds) {
    await sendMessage(id, text, extra);
  }
}

function isAdmin(userId) {
  return adminIds.has(Number(userId));
}

function getLargestPhoto(message) {
  if (!Array.isArray(message.photo) || !message.photo.length) {
    return null;
  }

  return message.photo[message.photo.length - 1].file_id;
}

function isCarPost(text) {
  return /в\s*продаж[еи]/i.test(String(text || ""));
}

function isSoldPost(text) {
  return /(^|[^а-яё])продан/i.test(String(text || "")) && !isCarPost(text);
}

// Короткое название авто для уведомлений
function carTitle(text) {
  const lines = String(text || "")
    .split("\n")
    .map(line => line.replace(/[*_`‼️❗️!]/g, "").trim())
    .filter(Boolean);

  const saleIndex = lines.findIndex(line => /в\s*продаж/i.test(line));

  if (saleIndex >= 0) {
    const rest = lines[saleIndex].replace(/.*в\s*продаж[еи]/i, "").trim();
    if (/[A-Za-z]/.test(rest)) return rest;
    if (lines[saleIndex + 1]) return lines[saleIndex + 1];
  }

  return lines.find(line => /[A-Za-z]{2,}/.test(line)) || "Автомобиль";
}

function carIdOf(car) {
  return String(car.id);
}

function messageIdsOf(car) {
  const ids = Array.isArray(car.sourceMessageIds) ? car.sourceMessageIds : [];
  return [...ids, car.sourceMessageId].filter(Boolean).map(String);
}

function photoCount(car) {
  if (Array.isArray(car.photos) && car.photos.length) return car.photos.length;
  return car.photo ? 1 : 0;
}

function toPublicCar(car) {
  const count = photoCount(car);

  return {
    ...car,
    status: car.status || "published",
    description: car.description || car.text || "",
    photos: Array.from(
      { length: count },
      (_, index) => `/api/cars/${encodeURIComponent(car.id)}/photos/${index}`
    ),
  };
}

function adminCarKeyboard(car) {
  const hidden = car.status === "hidden";

  return {
    inline_keyboard: [
      [
        hidden
          ? { text: "↩️ Вернуть в продажу", callback_data: `restore:${carIdOf(car)}` }
          : { text: "🏁 Продано → в архив", callback_data: `hide:${carIdOf(car)}` },
      ],
      [{ text: "📱 Открыть каталог", web_app: { url: miniAppUrl } }],
    ],
  };
}

function setCarStatus(carId, status) {
  const cars = readCars();
  const car = cars.find(item => String(item.id) === String(carId));

  if (!car) return null;

  car.status = status;
  car.updatedAt = new Date().toISOString();

  if (status === "hidden") {
    car.hiddenAt = car.updatedAt;
    car.soldAt = car.soldAt || car.updatedAt;
  }

  if (status === "published") {
    delete car.hiddenAt;
    delete car.soldAt;
  }

  saveCars(cars);
  return car;
}

// =========================
// TELEGRAM MINI APP AUTH
// =========================

// Проверка подписи initData по документации Telegram
function validateInitData(initData) {
  if (!initData) return null;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");

    if (!hash) return null;

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(token)
      .digest();

    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    const valid =
      calculatedHash.length === hash.length &&
      crypto.timingSafeEqual(Buffer.from(calculatedHash), Buffer.from(hash));

    if (!valid) return null;

    const authDate = Number(params.get("auth_date") || 0);
    const maxAge = 7 * 24 * 60 * 60;

    if (!authDate || Date.now() / 1000 - authDate > maxAge) return null;

    return JSON.parse(params.get("user") || "null");
  } catch (error) {
    console.error("Ошибка проверки initData:", error);
    return null;
  }
}

function requireAdmin(req, res, next) {
  const user = validateInitData(req.get("X-Telegram-Init-Data"));

  if (!user || !isAdmin(user.id)) {
    return res.status(403).json({ success: false, error: "Нет доступа" });
  }

  req.telegramUser = user;
  next();
}

// =========================
// EXPRESS API
// =========================

const app = express();

app.use(cors());
app.use(express.json({ limit: "20kb" }));

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("MICOOCAR API работает");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, cars: readCars().length });
});

async function sendCarPhoto(req, res, photoIndex = 0) {
  try {
    const car = readCars().find(
      item => String(item.id) === String(req.params.id)
    );

    if (!car) {
      return res.status(404).send("Автомобиль не найден");
    }

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

    const fileResult = await telegram("getFile", { file_id: fileId });
    const filePath = fileResult?.result?.file_path;

    if (!filePath) {
      return res.status(404).send("Файл Telegram не найден");
    }

    const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);

    if (!response.ok) {
      return res.status(502).send("Не удалось получить фото");
    }

    res.set("Content-Type", response.headers.get("content-type") || "image/jpeg");
    res.set("Cache-Control", "public, max-age=604800, immutable");
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error("Ошибка получения фото:", error);
    res.status(500).send("Ошибка сервера");
  }
}

app.get("/api/cars/:id/photo", (req, res) => {
  sendCarPhoto(req, res, 0);
});

app.get("/api/cars/:id/photos/:index", (req, res) => {
  const index = Number(req.params.index);

  if (!Number.isInteger(index) || index < 0) {
    return res.status(400).send("Неверный номер фотографии");
  }

  sendCarPhoto(req, res, index);
});

// Публичный каталог: только опубликованные авто, новые сверху
app.get("/api/cars", (req, res) => {
  try {
    // В продаже + проданные (клиенты видят историю продаж)
    const cars = readCars()
      .filter(car => car.status === "published" || car.status === "hidden")
      .sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")))
      .map(toPublicCar);

    res.json(cars);
  } catch (error) {
    console.error("API cars error:", error);
    res.status(500).json({ error: "Не удалось загрузить автомобили" });
  }
});

// ---------- Админ-API (только для ADMIN_ID / ADMIN_IDS) ----------

app.get("/api/admin/me", requireAdmin, (req, res) => {
  res.json({ success: true, admin: true, user: req.telegramUser });
});

app.get("/api/admin/cars", requireAdmin, (req, res) => {
  const cars = readCars()
    .filter(car => car.status === "published" || car.status === "hidden")
    .sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")))
    .map(car => ({ ...toPublicCar(car), stats: publicStats(car.id) }));

  res.json(cars);
});

app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const cars = readCars();
  const top = cars
    .filter(car => car.status === "published")
    .map(car => ({ id: car.id, title: carTitle(car.text), ...publicStats(car.id) }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 5);

  res.json({ success: true, ...statsSummary(), top });
});

// Засчитываем просмотр карточки (админы не считаются)
app.post("/api/cars/:id/view", (req, res) => {
  const car = readCars().find(item => String(item.id) === String(req.params.id));

  if (!car || (car.status !== "published" && car.status !== "hidden")) {
    return res.status(404).json({ success: false });
  }

  const user = validateInitData(req.get("X-Telegram-Init-Data"));

  if (user && isAdmin(user.id)) {
    return res.json({ success: true, counted: false });
  }

  const forwarded = String(req.get("x-forwarded-for") || req.ip || "").split(",")[0].trim();
  const viewerKey = user
    ? `tg:${user.id}`
    : `ip:${crypto.createHash("sha256").update(forwarded + token.slice(-8)).digest("hex").slice(0, 16)}`;

  const counted = trackView(car.id, viewerKey);
  res.json({ success: true, counted });
});

app.post("/api/admin/cars/:id/hide", requireAdmin, (req, res) => {
  const car = setCarStatus(req.params.id, "hidden");

  if (!car) {
    return res.status(404).json({ success: false, error: "Автомобиль не найден" });
  }

  console.log(`🙈 Скрыто из мини-аппа: ${car.id} (${req.telegramUser.id})`);
  res.json({ success: true, car: toPublicCar(car) });
});

app.post("/api/admin/cars/:id/restore", requireAdmin, (req, res) => {
  const car = setCarStatus(req.params.id, "published");

  if (!car) {
    return res.status(404).json({ success: false, error: "Автомобиль не найден" });
  }

  console.log(`👁 Возвращено в каталог: ${car.id} (${req.telegramUser.id})`);
  res.json({ success: true, car: toPublicCar(car) });
});

app.delete("/api/admin/cars/:id", requireAdmin, (req, res) => {
  const cars = readCars();
  const index = cars.findIndex(item => String(item.id) === String(req.params.id));

  if (index < 0) {
    return res.status(404).json({ success: false, error: "Автомобиль не найден" });
  }

  const [removed] = cars.splice(index, 1);
  saveCars(cars);

  console.log(`🗑 Удалено навсегда: ${removed.id} (${req.telegramUser.id})`);
  res.json({ success: true });
});

// ---------- Заявки из Mini App ----------

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

    const phoneValue = String(phone || "").trim().slice(0, 32);
    const phoneDigits = phoneValue.replace(/\D/g, "");

    if (phoneDigits.length < 7 || phoneDigits.length > 15) {
      return res.status(400).json({
        success: false,
        error: "Укажите корректный номер телефона",
      });
    }

    const clientName =
      [firstName, lastName].filter(Boolean).join(" ").slice(0, 100) || "Не указано";

    const cleanUsername = String(username || "").replace(/^@/, "").trim();
    const validUsername = /^[A-Za-z0-9_]{5,32}$/.test(cleanUsername);
    const clientTelegram = validUsername ? `@${cleanUsername}` : "username не указан";

    const message = [
      "🔥 НОВАЯ ЗАЯВКА MICOOR CAR",
      "",
      "🚗 АВТОМОБИЛЬ",
      `Марка и модель: ${[brand, model].filter(Boolean).join(" ").slice(0, 120) || "Не указано"}`,
      `Цена: ${String(price || "Не указана").slice(0, 60)}`,
      `VIN: ${String(vin || "Не указан").slice(0, 40)}`,
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
              { text: "Открыть Telegram клиента", url: `https://t.me/${cleanUsername}` },
            ]],
          },
        }
      : {};

    const result = await sendMessage(leadsChatId, message, extra);

    if (result?.ok) trackLead(carId, "leads");

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

// ---------- Анкета пожеланий из Mini App ----------

const WISH_LABELS = [
  ["body", "🚗 Кузов"],
  ["budget", "💰 Бюджет под ключ"],
  ["year", "📅 Год выпуска"],
  ["fuel", "⛽ Двигатель"],
  ["brands", "🏷 Марки"],
  ["priorities", "⭐ Важно"],
  ["timing", "⏱ Покупка"],
];

function cleanList(value) {
  return (Array.isArray(value) ? value : [])
    .map(item => String(item || "").trim().slice(0, 100))
    .filter(Boolean)
    .slice(0, 16);
}

app.post("/api/wishes", async (req, res) => {
  try {
    const { answers, comment, phone, matches, userId, username, firstName, lastName } = req.body || {};

    const phoneValue = String(phone || "").trim().slice(0, 32);
    const phoneDigits = phoneValue.replace(/\D/g, "");

    if (phoneDigits.length < 7 || phoneDigits.length > 15) {
      return res.status(400).json({ success: false, error: "Укажите корректный номер телефона" });
    }

    const safeAnswers = answers && typeof answers === "object" ? answers : {};
    const lines = WISH_LABELS.map(([key, label]) => {
      const list = cleanList(safeAnswers[key]);
      return `${label}: ${list.length ? list.join(", ") : "—"}`;
    });

    const commentText = String(comment || "").trim().slice(0, 600);
    const clientName = [firstName, lastName].filter(Boolean).join(" ").slice(0, 100) || "Не указано";
    const cleanUsername = String(username || "").replace(/^@/, "").trim();
    const validUsername = /^[A-Za-z0-9_]{5,32}$/.test(cleanUsername);
    const matchCount = Math.max(0, Math.min(999, Number(matches) || 0));

    const message = [
      "📝 АНКЕТА ПОДБОРА MICOOR CAR",
      "",
      ...lines,
      commentText ? `💬 Пожелания: ${commentText}` : null,
      "",
      matchCount ? `✅ В каталоге уже подходит: ${matchCount}` : "🔎 В каталоге совпадений нет — нужен подбор",
      "",
      "👤 КЛИЕНТ",
      `Телефон: ${phoneValue}`,
      `Имя: ${clientName}`,
      `Telegram: ${validUsername ? `@${cleanUsername}` : "username не указан"}`,
      `Telegram ID: ${Number(userId) || "не передан"}`,
    ].filter(line => line !== null).join("\n");

    const extra = validUsername
      ? {
          reply_markup: {
            inline_keyboard: [[{ text: "Написать клиенту", url: `https://t.me/${cleanUsername}` }]],
          },
        }
      : {};

    const result = await sendMessage(leadsChatId, message, extra);

    if (result?.ok) trackLead(null, "wishes");

    if (!result || !result.ok) {
      console.error("Не удалось отправить анкету в группу лидов:", result);
      return res.status(502).json({ success: false, error: "Не удалось доставить анкету менеджеру" });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("Ошибка API wishes:", error);
    return res.status(500).json({ success: false, error: "Не удалось обработать анкету" });
  }
});

if (require.main === module) app.listen(PORT, "0.0.0.0", () => {
  console.log(`MICOOCAR API запущен на порту ${PORT}`);
});

// =========================
// АВТОИМПОРТ ИЗ КАНАЛА
// =========================

const channelAlbums = new Map();
const announcedChannels = new Set();

function isWatchedChannel(chat) {
  if (!channelFilter) return true;

  const filter = channelFilter.replace(/^@/, "").toLowerCase();

  return (
    String(chat.id) === channelFilter ||
    String(chat.username || "").toLowerCase() === filter
  );
}

async function announceChannel(chat) {
  if (channelFilter || announcedChannels.has(chat.id)) return;

  announcedChannels.add(chat.id);
  console.log(`Канал подключён: ${chat.title} (${chat.id})`);

  await notifyAdmins(
    `📡 Бот видит канал «${chat.title}».\n\nID канала: ${chat.id}\n\nЧтобы бот слушал только этот канал, добавьте в настройки сервера переменную CHANNEL_ID=${chat.id}`
  );
}

async function importChannelCar(messages) {
  const sorted = [...messages].sort((a, b) => a.message_id - b.message_id);
  const first = sorted[0];
  const chat = first.chat;

  const textMessage = sorted.find(message => message.caption || message.text);
  const text = String(textMessage?.caption || textMessage?.text || "").trim();

  if (!isCarPost(text)) {
    console.log(`Пост ${chat.id}/${first.message_id} пропущен: нет «В продаже»`);
    return;
  }

  const messageIds = sorted.map(message => String(message.message_id));
  const photos = sorted.map(getLargestPhoto).filter(Boolean);

  const cars = readCars();

  const duplicate = cars.find(
    car =>
      String(car.sourceChatId) === String(chat.id) &&
      messageIdsOf(car).some(id => messageIds.includes(id))
  );

  if (duplicate) {
    console.log(`Пост ${chat.id}/${first.message_id} уже в каталоге (${duplicate.id})`);
    return;
  }

  const now = new Date().toISOString();

  const car = {
    id: `car_${Date.now()}`,
    source: "channel",
    sourceChatId: chat.id,
    sourceChatUsername: chat.username || null,
    sourceMessageId: first.message_id,
    sourceMessageIds: messageIds,
    text,
    description: text,
    photo: photos[0] || null,
    photos,
    publishedAt: new Date((first.date || Date.now() / 1000) * 1000).toISOString(),
    createdAt: now,
    status: "published",
  };

  cars.push(car);
  await saveCars(cars);

  console.log(`✅ Авто из канала добавлено: ${car.id} — ${carTitle(text)}`);

  await notifyAdmins(
    `✅ Новое авто в каталоге\n\n🚗 ${carTitle(text)}\n📸 Фото: ${photos.length}\n\nОпубликовано автоматически из канала.`,
    { reply_markup: adminCarKeyboard(car) }
  );
}

async function handleChannelEdit(post) {
  const text = String(post.caption || post.text || "").trim();
  const cars = readCars();

  const car = cars.find(
    item =>
      String(item.sourceChatId) === String(post.chat.id) &&
      messageIdsOf(item).includes(String(post.message_id))
  );

  if (!car) {
    // Пост отредактировали и добавили «В продаже» — импортируем как новый
    if (isCarPost(text) && !post.media_group_id) {
      await importChannelCar([post]);
    }
    return;
  }

  // Замена фото в отредактированном сообщении
  const newPhoto = getLargestPhoto(post);
  if (newPhoto) {
    const index = messageIdsOf(car).indexOf(String(post.message_id));
    if (Array.isArray(car.photos) && index >= 0 && index < car.photos.length) {
      car.photos[index] = newPhoto;
      car.photo = car.photos[0];
    }
  }

  if (text) {
    car.text = text;
    car.description = text;
  }

  car.updatedAt = new Date().toISOString();

  // В канале написали «ПРОДАНО» — убираем из каталога
  if (text && isSoldPost(text) && car.status === "published") {
    car.status = "hidden";
    car.hiddenAt = car.updatedAt;
    car.soldAt = car.updatedAt;

    await saveCars(cars);
    await notifyAdmins(
      `🏁 Продано: ${carTitle(car.text)}\n\nПост отмечен как проданный — авто скрыто из каталога.`,
      { reply_markup: adminCarKeyboard(car) }
    );
    return;
  }

  await saveCars(cars);
  console.log(`✏️ Авто обновлено из канала: ${car.id}`);
}

async function handleChannelPost(post, isEdit = false) {
  if (!isWatchedChannel(post.chat)) return;

  await announceChannel(post.chat);

  if (isEdit) {
    await handleChannelEdit(post);
    return;
  }

  if (!post.media_group_id) {
    await importChannelCar([post]);
    return;
  }

  // Альбом приходит отдельными сообщениями — собираем их вместе
  const key = `${post.chat.id}:${post.media_group_id}`;
  let album = channelAlbums.get(key);

  if (!album) {
    album = { messages: [], timer: null };
    channelAlbums.set(key, album);
  }

  album.messages.push(post);
  clearTimeout(album.timer);

  album.timer = setTimeout(async () => {
    channelAlbums.delete(key);

    try {
      await importChannelCar(album.messages);
    } catch (error) {
      console.error("Ошибка импорта альбома из канала:", error);
      await notifyAdmins("❌ Не удалось добавить авто из канала. Проверьте логи сервера.");
    }
  }, 2500);
}

// =========================
// РУЧНОЙ ИМПОРТ (пересылка боту)
// =========================

const pendingAlbums = new Map();
const pendingCarDescriptions = new Map();

async function saveImportedCar(chatId, messages, descriptionOverride = "") {
  const sortedMessages = [...messages].sort((a, b) => a.message_id - b.message_id);
  const firstMessage = sortedMessages[0];

  const sourceChatId =
    firstMessage.forward_origin?.chat?.id ||
    firstMessage.forward_from_chat?.id ||
    chatId;

  const sourceMessageId =
    firstMessage.forward_origin?.message_id ||
    firstMessage.forward_from_message_id ||
    firstMessage.message_id;

  const textMessage = sortedMessages.find(message => message.caption || message.text);
  const embeddedText = String(textMessage?.caption || textMessage?.text || "").trim();

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

    const count = sortedMessages.map(getLargestPhoto).filter(Boolean).length;

    await sendMessage(
      chatId,
      `📸 Получено фотографий: ${count}.\n\nТеперь отправьте следующим сообщением полный текст этого объявления.\n\nДля отмены напишите /cancel.`
    );
    return;
  }

  const photos = sortedMessages.map(getLargestPhoto).filter(Boolean);
  const cars = readCars();

  const duplicate = cars.find(
    car =>
      String(car.sourceChatId) === String(sourceChatId) &&
      messageIdsOf(car).includes(String(sourceMessageId))
  );

  if (duplicate && duplicate.status !== "pending") {
    await sendMessage(chatId, "⚠️ Этот автомобиль уже есть в каталоге.", {
      reply_markup: adminCarKeyboard(duplicate),
    });
    return;
  }

  const car = duplicate || {
    id: `car_${Date.now()}`,
    source: "forward",
    sourceChatId,
    sourceMessageId,
  };

  Object.assign(car, {
    text: originalText,
    description: originalText,
    photo: photos[0] || null,
    photos,
    publishedAt: new Date().toISOString(),
    status: "pending",
  });

  if (!duplicate) cars.push(car);

  await saveCars(cars);

  await sendMessage(
    chatId,
    `🚗 ${carTitle(originalText)}\n📸 Фотографий: ${photos.length}\n\nОпубликовать автомобиль?`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Опубликовать", callback_data: `publish:${car.id}` },
          { text: "❌ Отмена", callback_data: `cancel:${car.id}` },
        ]],
      },
    }
  );
}

function queueAlbumMessage(message) {
  const chatId = message.chat.id;
  const key = `${chatId}:${message.media_group_id}`;

  let album = pendingAlbums.get(key);

  if (!album) {
    album = { chatId, messages: [], timer: null };
    pendingAlbums.set(key, album);
  }

  album.messages.push(message);
  clearTimeout(album.timer);

  album.timer = setTimeout(async () => {
    pendingAlbums.delete(key);

    try {
      await saveImportedCar(album.chatId, album.messages);
    } catch (error) {
      console.error("Ошибка импорта альбома:", error);
      await sendMessage(album.chatId, "❌ Не удалось импортировать альбом.");
    }
  }, 1800);
}

// =========================
// BOT COMMANDS
// =========================

function catalogButton(text = "🚗 Открыть каталог") {
  return {
    reply_markup: {
      inline_keyboard: [[{ text, web_app: { url: miniAppUrl } }]],
    },
  };
}

async function sendAdminStats(chatId) {
  const cars = readCars();
  const published = cars.filter(car => car.status === "published");
  const sold = cars.filter(car => car.status === "hidden").length;
  const summary = statsSummary();

  const top = published
    .map(car => ({ title: carTitle(car.text), ...publicStats(car.id) }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 3)
    .map((car, index) => `${index + 1}. ${car.title} — 👁 ${car.views}, заявок ${car.leads}`);

  await sendMessage(
    chatId,
    [
      "🛠 Панель администратора MICOOR CAR",
      "",
      `✅ В продаже: ${published.length}`,
      `🏁 В архиве проданных: ${sold}`,
      "",
      `👁 Просмотров сегодня: ${summary.todayViews}`,
      `👁 За 7 дней: ${summary.weekViews}`,
      `📩 Заявок и анкет за 7 дней: ${summary.weekLeads}`,
      top.length ? "\n🔥 Самые просматриваемые:\n" + top.join("\n") : "",
      "",
      "Подробная статистика и архив — в мини-аппе.",
    ].join("\n"),
    catalogButton("🛠 Открыть мини-апп")
  );
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const fromId = message.from?.id;
  const isPrivate = message.chat.type === "private";
  const text = message.text || "";

  if (!isPrivate) return; // в группах бот только отправляет заявки

  const admin = isAdmin(fromId);

  // Описание для альбома, пересланного без текста
  if (admin && pendingCarDescriptions.has(String(chatId)) && message.text) {
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
        await sendMessage(chatId, "❌ Не удалось сохранить объявление. Попробуйте ещё раз.");
      }
      return;
    }
  }

  if (text === "/myid") {
    await sendMessage(chatId, `Ваш Telegram ID: ${fromId}`);
    return;
  }

  if (text === "/admin" && admin) {
    await sendAdminStats(chatId);
    return;
  }

  if (text === "/start" || text.startsWith("/start ")) {
    await sendMessage(
      chatId,
      "🚗 MICOOR CAR\n\nПрямой экспорт автомобилей из Китая.\nЦены «под ключ» до Уссурийска — с доставкой и растаможкой.",
      {
        reply_markup: {
          keyboard: [
            [{ text: "🚗 Каталог" }],
            [{ text: "📩 Оставить заявку" }, { text: "👨‍💼 Менеджер" }],
          ],
          resize_keyboard: true,
        },
      }
    );

    await sendMessage(chatId, "Откройте каталог автомобилей 👇", catalogButton());
    return;
  }

  if (text === "🚗 Каталог" || text === "/catalog") {
    await sendMessage(chatId, "🚗 Каталог MICOOR CAR:", catalogButton());
    return;
  }

  if (text === "❤️ Избранное") {
    await sendMessage(chatId, "❤️ Избранное доступно в каталоге — нажмите на сердечко у авто.", catalogButton());
    return;
  }

  if (text === "🧮 Калькулятор") {
    await sendMessage(chatId, "🧮 Калькулятор скоро появится. А пока менеджер рассчитает стоимость под ваш запрос.");
    return;
  }

  if (text === "📩 Оставить заявку" || text === "/podbor") {
    await sendMessage(
      chatId,
      "📝 Ответьте на 7 коротких вопросов — подберём авто под ваш бюджет и пожелания.\n\nИли напишите менеджеру: @arturexpo",
      {
        reply_markup: {
          inline_keyboard: [[{ text: "📝 Заполнить анкету", web_app: { url: `${miniAppUrl}?page=wish` } }]],
        },
      }
    );
    return;
  }

  if (text === "👨‍💼 Менеджер") {
    await sendMessage(chatId, "👨‍💼 Менеджер MICOOR CAR: @arturexpo", {
      reply_markup: {
        inline_keyboard: [[{ text: "Написать менеджеру", url: "https://t.me/arturexpo" }]],
      },
    });
    return;
  }

  if (!admin) return;

  // Ручной импорт: админ пересылает пост боту
  const isForwarded = message.forward_origin || message.forward_from || message.forward_from_chat;
  const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
  const hasText = Boolean(message.text) || Boolean(message.caption);

  if (message.media_group_id && hasPhoto) {
    queueAlbumMessage(message);
    return;
  }

  if ((isForwarded || hasPhoto) && hasText) {
    await saveImportedCar(chatId, [message]);
  }
}

// =========================
// CALLBACKS
// =========================

async function answer(callback, text) {
  return telegram("answerCallbackQuery", {
    callback_query_id: callback.id,
    text,
  });
}

async function handleCallback(callback) {
  const data = callback.data || "";

  if (!isAdmin(callback.from?.id)) {
    await answer(callback, "Только для администратора");
    return;
  }

  const [action, ...rest] = data.split(":");
  const carId = rest.join(":");
  const cars = readCars();

  // Совместимость со старыми кнопками publish:<chatId>:<messageId>
  const car =
    cars.find(item => String(item.id) === carId) ||
    (rest.length === 2
      ? cars.find(
          item =>
            String(item.sourceChatId) === String(rest[0]) &&
            messageIdsOf(item).includes(String(rest[1]))
        )
      : null);

  if (!car) {
    await answer(callback, "Автомобиль не найден");
    return;
  }

  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const title = carTitle(car.text);

  if (action === "publish" || action === "restore") {
    if (car.status === "published") {
      await answer(callback, "Уже в каталоге");
      return;
    }

    setCarStatus(car.id, "published");
    await answer(callback, "Опубликовано в каталоге");
    await telegram("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `✅ В каталоге: ${title}`,
      reply_markup: adminCarKeyboard({ ...car, status: "published" }),
    });
    return;
  }

  if (action === "hide") {
    setCarStatus(car.id, "hidden");
    await answer(callback, "Перенесено в архив проданных");
    await telegram("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `🏁 Продано, в архиве: ${title}`,
      reply_markup: adminCarKeyboard({ ...car, status: "hidden" }),
    });
    return;
  }

  if (action === "cancel") {
    if (car.status === "pending") {
      saveCars(cars.filter(item => item !== car));
    }

    await answer(callback, "Импорт отменён");
    await telegram("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `❌ Импорт отменён: ${title}`,
    });
  }
}

// =========================
// LONG POLLING
// =========================

let offset = 0;

async function processUpdate(update) {
  if (update.message) await handleMessage(update.message);
  if (update.callback_query) await handleCallback(update.callback_query);
  if (update.channel_post) await handleChannelPost(update.channel_post);
  if (update.edited_channel_post) await handleChannelPost(update.edited_channel_post, true);
}

async function startBot() {
  console.log("MICOOCAR BOT запускается...");

  // Кнопка «Каталог» рядом с полем ввода во всех чатах с ботом
  await telegram("setChatMenuButton", {
    menu_button: { type: "web_app", text: "Каталог", web_app: { url: miniAppUrl } },
  });

  await telegram("setMyCommands", {
    commands: [
      { command: "start", description: "Главное меню" },
      { command: "catalog", description: "Каталог автомобилей" },
      { command: "podbor", description: "Анкета подбора авто" },
    ],
  });

  while (true) {
    try {
      const result = await telegram("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query", "channel_post", "edited_channel_post"],
      });

      if (!result.ok) {
        await sleep(3000);
        continue;
      }

      for (const update of result.result) {
        offset = update.update_id + 1;

        try {
          await processUpdate(update);
        } catch (error) {
          console.error("Ошибка обработки update:", error);
        }
      }
    } catch (error) {
      console.error("Ошибка бота:", error);
      await sleep(3000);
    }
  }
}

// Бесплатный Render засыпает без запросов — пингуем себя раз в 10 минут
if (publicUrl && require.main === module) {
  setInterval(() => {
    fetch(`${publicUrl.replace(/\/$/, "")}/health`).catch(() => {});
  }, 10 * 60 * 1000);
}

console.log("MICOOCAR BOT: @micoocarbot");
console.log(`Админы: ${[...adminIds].join(", ")}`);
console.log(channelFilter ? `Канал: ${channelFilter}` : "Канал: любой, где бот админ");

if (require.main === module) {
  (async () => {
    await syncCarsFromGitHub();
    await syncFileFromGitHub("stats.json", statsFile);
    loadStats();
    await startBot();
  })();
}

module.exports = {
  app,
  processUpdate,
  validateInitData,
  carTitle,
  isCarPost,
  isSoldPost,
  readCars,
};
