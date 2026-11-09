require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { calculateCustoms, RATES_UPDATED } = require("./customs");
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

  const day = statsDay();
  item.days = item.days || {};
  item.days[day] = (item.days[day] || 0) + 1;

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

function viewsToday(carId) {
  return stats.cars[String(carId)]?.days?.[statsDay()] || 0;
}

function saveStats() {
  // Просмотры по дням для каждой машины — только последние 14 дней
  const keepFrom = statsDay(14);
  Object.values(stats.cars).forEach(item => {
    Object.keys(item.days || {}).forEach(day => {
      if (day < keepFrom) delete item.days[day];
    });
  });

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


// =========================
// ПОДПИСКИ НА ПОИСК
// =========================

const subsFile = path.join(__dirname, "subscriptions.json");
let subscriptions = [];

function loadSubscriptions() {
  try {
    const data = JSON.parse(fs.readFileSync(subsFile, "utf8"));
    subscriptions = Array.isArray(data) ? data : [];
  } catch {
    subscriptions = [];
  }
}

function saveSubscriptions() {
  fs.writeFileSync(subsFile, JSON.stringify(subscriptions));
  githubQueue = githubQueue.then(() => pushFileToGitHub("subscriptions.json", subsFile)).catch(() => {});
  return githubQueue;
}

// =========================
// ПРОФИЛИ КЛИЕНТОВ И ИСТОРИЯ ЗАЯВОК
// =========================

const profilesFile = path.join(__dirname, "profiles.json");
const requestsFile = path.join(__dirname, "requests.json");
let profiles = {};
let requests = [];

function loadProfiles() {
  try {
    const data = JSON.parse(fs.readFileSync(profilesFile, "utf8"));
    profiles = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    profiles = {};
  }
  try {
    const data = JSON.parse(fs.readFileSync(requestsFile, "utf8"));
    requests = Array.isArray(data) ? data : [];
  } catch {
    requests = [];
  }
}

function saveProfiles() {
  fs.writeFileSync(profilesFile, JSON.stringify(profiles));
  githubQueue = githubQueue.then(() => pushFileToGitHub("profiles.json", profilesFile)).catch(() => {});
  return githubQueue;
}

function saveRequests() {
  // храним последние 3000 заявок
  if (requests.length > 3000) requests = requests.slice(-3000);
  fs.writeFileSync(requestsFile, JSON.stringify(requests));
  githubQueue = githubQueue.then(() => pushFileToGitHub("requests.json", requestsFile)).catch(() => {});
  return githubQueue;
}

function profileOf(userId) {
  return userId ? profiles[String(userId)] || null : null;
}

function wantsNotifications(userId) {
  return profileOf(userId)?.notifications !== false;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

const REQUEST_STATUS = {
  new: "🆕 Новая",
  work: "🟡 В работе",
  done: "✅ Завершена",
};

function addRequest({ userId, type, carId, title, summary }) {
  const item = {
    id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    userId: userId || null,
    type,
    carId: carId || null,
    title: String(title || "").slice(0, 120),
    summary: String(summary || "").slice(0, 200),
    status: "new",
    createdAt: new Date().toISOString(),
  };
  requests.push(item);
  saveRequests();
  return item;
}

function requestKeyboard(item, username) {
  const rows = [];
  if (username) rows.push([{ text: "💬 Написать клиенту", url: `https://t.me/${username}` }]);
  rows.push([
    { text: `${item.status === "work" ? "● " : ""}🟡 В работе`, callback_data: `lead:${item.id}:work` },
    { text: `${item.status === "done" ? "● " : ""}✅ Завершена`, callback_data: `lead:${item.id}:done` },
  ]);
  if (item.userId) {
    rows.push([{ text: item.dealId ? "🚗 Покупка оформлена" : "🤝 Клиент купил — вести авто", callback_data: `deal:${item.id}` }]);
  }
  return { reply_markup: { inline_keyboard: rows } };
}

function profileLines(userId) {
  const profile = profileOf(userId);
  if (!profile) return [];
  return [
    profile.phone && profile.phoneVerified ? `Телефон из профиля: ${profile.phone} ✓ подтверждён через Telegram` : null,
    profile.email ? `Почта: ${profile.email}${profile.emailVerified ? " ✓ подтверждена" : " (не подтверждена)"}` : null,
    profile.city ? `Город доставки: ${profile.city}` : null,
  ].filter(Boolean);
}

// =========================
// СДЕЛКИ (ОТСЛЕЖИВАНИЕ АВТО) И ОТЗЫВЫ
// =========================

const dealsFile = path.join(__dirname, "deals.json");
const reviewsFile = path.join(__dirname, "reviews.json");
let deals = [];
let reviews = [];

const DEAL_STAGES = [
  { id: "bought", title: "Авто выкуплен", emoji: "🤝" },
  { id: "shipping", title: "В пути к границе", emoji: "🚛" },
  { id: "customs", title: "Таможенное оформление", emoji: "🛃" },
  { id: "delivery", title: "Едет к вам", emoji: "🚚" },
  { id: "arrived", title: "Авто приехал", emoji: "🎉" },
];
const DEAL_STAGE = Object.fromEntries(DEAL_STAGES.map(stage => [stage.id, stage]));

function loadDeals() {
  try {
    const data = JSON.parse(fs.readFileSync(dealsFile, "utf8"));
    deals = Array.isArray(data) ? data : [];
  } catch {
    deals = [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(reviewsFile, "utf8"));
    reviews = Array.isArray(data) ? data : [];
  } catch {
    reviews = [];
  }
}

function saveDeals() {
  fs.writeFileSync(dealsFile, JSON.stringify(deals));
  githubQueue = githubQueue.then(() => pushFileToGitHub("deals.json", dealsFile)).catch(() => {});
  return githubQueue;
}

function saveReviews() {
  fs.writeFileSync(reviewsFile, JSON.stringify(reviews));
  githubQueue = githubQueue.then(() => pushFileToGitHub("reviews.json", reviewsFile)).catch(() => {});
  return githubQueue;
}

function clientName(userId) {
  const profile = profileOf(userId);
  if (profile?.firstName) return profile.firstName + (profile.username ? ` (@${profile.username})` : "");
  if (profile?.username) return `@${profile.username}`;
  return `ID ${userId}`;
}

function createDeal({ userId, carId, title, adminName }) {
  const deal = {
    id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    userId: Number(userId),
    carId: carId || null,
    title: String(title || "Автомобиль").slice(0, 120),
    stage: "bought",
    history: [{ stage: "bought", note: "", at: new Date().toISOString(), by: adminName || "" }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  deals.push(deal);
  saveDeals();
  return deal;
}

async function notifyDealUpdate(deal, entry) {
  const stage = DEAL_STAGE[deal.stage];
  const stageChanged = entry.stage;
  const lines = stageChanged
    ? [`${stage.emoji} ${deal.title}`, "", `Статус: ${stage.title}`]
    : [`📍 ${deal.title}`, "", "Новая отметка по вашему авто"];
  if (entry.note) lines.push("", `💬 ${entry.note}`);

  if (stageChanged === "arrived") {
    lines.push("", "Поздравляем с покупкой! 🙌", "Будем рады, если вы оставите отзыв и пришлёте фото с автомобилем — это займёт минуту.");
  }

  return sendMessage(deal.userId, lines.join("\n"), {
    reply_markup: {
      inline_keyboard: [[webAppButton(stageChanged === "arrived" ? "⭐ Оставить отзыв" : "📍 Где мой автомобиль", "?page=profile")]],
    },
  });
}

function publicDeal(deal) {
  const review = reviews.find(item => item.dealId === deal.id);
  return {
    id: deal.id,
    carId: deal.carId,
    title: deal.title,
    stage: deal.stage,
    history: deal.history,
    createdAt: deal.createdAt,
    reviewStatus: review ? review.status : null,
  };
}

function publicReview(review) {
  return {
    id: review.id,
    name: review.name,
    carTitle: review.carTitle,
    rating: review.rating,
    text: review.text,
    photos: (review.photos || []).map((_, index) => `/api/reviews/${review.id}/photos/${index}`),
    createdAt: review.createdAt,
  };
}

loadProfiles();
loadDeals();

const FACT_BRANDS = ["Mercedes-Benz", "Mercedes", "Li Auto", "Land Rover", "Volkswagen", "Toyota", "Honda", "Nissan", "Mazda", "Subaru", "Mitsubishi", "Suzuki", "Lexus", "Audi", "BMW", "MINI", "BYD", "Zeekr", "Lixiang", "Kia", "Hyundai", "Genesis", "Porsche", "Ford", "Chevrolet", "Chery", "Geely", "GWM", "Haval", "Tank", "Hongqi", "Avatr", "NIO", "Xiaomi", "XPeng", "JAC", "Jetour", "Voyah", "Denza", "Deepal", "Leapmotor", "Cadillac", "Volvo", "Skoda", "Renault", "Peugeot", "Dongfeng", "Changan", "Wuling", "Buick", "Infiniti", "Acura", "Cupra", "Opel", "Isuzu", "MG", "Smart"];
const BRAND_CANON = { "mercedes": "Mercedes-Benz", "lixiang": "Li Auto" };

function digitsOf(value) {
  return Number(String(value || "").replace(/[^\d]/g, "")) || 0;
}

// Ключевые параметры авто из текста поста (для подписок и меток)
function carFacts(car) {
  const text = String(car.text || car.description || "").replace(/\*/g, "");
  const title = carTitle(text);
  let brand = "";
  let model = "";

  for (const name of FACT_BRANDS) {
    const match = title.match(new RegExp(`(^|\\s)${name.replace(/[-\s]/g, "[-\\s]")}(\\s|$)`, "i"));
    if (match) {
      brand = BRAND_CANON[name.toLowerCase()] || name;
      model = title.slice(match.index + match[0].length).trim();
      break;
    }
  }

  const words = model.split(/\s+/).filter(Boolean);
  let family = words[0] || "";
  if (words[1] && /^(series|class|klasse|серии|класс)$/i.test(words[1])) family = `${words[0]} ${words[1]}`;
  else if (words[1] && /^[A-ZА-Я]{3,}$/.test(words[0]) && /^[A-ZА-Я]{3,}$/.test(words[1])) family = `${words[0]} ${words[1]}`;

  const priceLine = text.match(/💰\s*([^\n]+)/) || text.match(/Цена\s*[—:–-]?\s*([^\n]+)/i);

  return {
    title,
    brand,
    family,
    price: priceLine ? digitsOf(priceLine[1]) : 0,
    year: Number(text.match(/((?:19|20)\d{2})\s*год/i)?.[1]) || 0,
    mileage: digitsOf(text.match(/Пробег\s*[—:–-]?\s*([\d\s.,]+)\s*км/i)?.[1]),
    volume: parseFloat(String(text.match(/(\d+(?:[.,]\d+)?)\s*[TТ]?\s*(?:Бензин|Дизель|Гибрид|Электро)/i)?.[1] || "").replace(",", ".")) || 0,
    power: Number(text.match(/Мощность\s*[—:–-]?\s*(\d+)/i)?.[1]) || 0,
    fuel: text.match(/(Бензин|Дизель|Гибрид|Электро)/i)?.[1] || "",
  };
}

function subscriptionMatches(filters, facts) {
  const f = filters || {};
  const n = (value) => digitsOf(value);

  if (f.brand && f.brand !== facts.brand) return false;
  if (f.model && f.model !== facts.family) return false;
  if (f.priceFrom && facts.price < n(f.priceFrom)) return false;
  if (f.priceTo && (!facts.price || facts.price > n(f.priceTo))) return false;
  if (f.yearFrom && facts.year < Number(f.yearFrom)) return false;
  if (f.yearTo && (!facts.year || facts.year > Number(f.yearTo))) return false;
  if (f.mileageTo && facts.mileage > n(f.mileageTo)) return false;
  if (f.volumeFrom && facts.volume < Number(f.volumeFrom)) return false;
  if (f.volumeTo && (!facts.volume || facts.volume > Number(f.volumeTo))) return false;
  if (f.powerFrom && facts.power < n(f.powerFrom)) return false;
  if (f.powerTo && (!facts.power || facts.power > n(f.powerTo))) return false;
  if (Array.isArray(f.fuel) && f.fuel.length && !f.fuel.some(item => String(facts.fuel).toLowerCase() === String(item).toLowerCase())) return false;
  return true;
}

function formatRub(value) {
  return `${Number(value).toLocaleString("ru-RU")} ₽`;
}

function carOpenButton(car, text = "Открыть в каталоге") {
  return {
    reply_markup: {
      inline_keyboard: [[{ text, web_app: { url: `${miniAppUrl}?car=${encodeURIComponent(car.id)}` } }]],
    },
  };
}

async function notifySubscribers(car, kind, extra = {}) {
  if (!subscriptions.length) return;

  const facts = carFacts(car);
  const details = [facts.year, facts.mileage ? `${facts.mileage.toLocaleString("ru-RU")} км` : "", facts.fuel]
    .filter(Boolean)
    .join(" · ");

  const removed = new Set();
  let sent = 0;

  for (const sub of subscriptions) {
    if (kind === "price" && !sub.priceDrops) continue;
    if (!wantsNotifications(sub.userId)) continue;
    if (!subscriptionMatches(sub.filters, facts)) continue;

    const text = kind === "price"
      ? `📉 Цена снижена на авто из вашего поиска\n\n🚗 ${facts.title}\n${details}\n\nБыло: ${formatRub(extra.oldPrice)}\nСтало: ${formatRub(facts.price)} (−${formatRub(extra.oldPrice - facts.price)})`
      : `🔔 Новое авто по вашему поиску\n\n🚗 ${facts.title}\n${details}${facts.price ? `\n💰 ${formatRub(facts.price)} под ключ` : ""}`;

    const result = await sendMessage(sub.userId, text, carOpenButton(car));
    if (result?.ok) sent += 1;

    // Пользователь заблокировал бота — подписка больше не нужна
    if (result && !result.ok && result.error_code === 403) removed.add(sub.id);
    await sleep(60);
  }

  if (removed.size) {
    subscriptions = subscriptions.filter(sub => !removed.has(sub.id));
    saveSubscriptions();
  }

  if (sent) console.log(`🔔 Подписчикам отправлено (${kind}): ${sent}`);
}

loadSubscriptions();

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

  if (!data.ok && !(method === "getUpdates" && data.error_code === 409)) {
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
const smallJson = express.json({ limit: "20kb" });
const reviewJson = express.json({ limit: "9mb" });
app.use((req, res, next) => (req.path === "/api/reviews" ? reviewJson : smallJson)(req, res, next));

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
      .map(car => ({ ...toPublicCar(car), viewsToday: viewsToday(car.id) }));

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

    const verifiedUser = validateInitData(req.get("X-Telegram-Init-Data"));
    const leadUserId = verifiedUser?.id || null;
    const carTitleText = [brand, model].filter(Boolean).join(" ").replace(/^🔁[^:]*:\s*/, "").slice(0, 120) || "Автомобиль";
    const request = addRequest({
      userId: leadUserId,
      type: "car",
      carId,
      title: carTitleText,
      summary: String(price || "").slice(0, 60),
    });

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
      `Telegram ID: ${leadUserId || userId || "не передан"}`,
      ...profileLines(leadUserId),
      "",
      `Статус: ${REQUEST_STATUS.new}`,
    ].join("\n");

    const extra = requestKeyboard(request, validUsername ? cleanUsername : null);

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

// ---------- Подписки на поиск ----------

function requireUser(req, res, next) {
  const user = validateInitData(req.get("X-Telegram-Init-Data"));
  if (!user) {
    return res.status(401).json({ success: false, error: "Откройте каталог через Telegram-бота" });
  }
  req.telegramUser = user;
  next();
}

function cleanFilters(input) {
  const f = input && typeof input === "object" ? input : {};
  const str = (value) => String(value || "").slice(0, 40);
  return {
    brand: str(f.brand),
    model: str(f.model),
    priceFrom: str(f.priceFrom),
    priceTo: str(f.priceTo),
    yearFrom: str(f.yearFrom),
    yearTo: str(f.yearTo),
    mileageTo: str(f.mileageTo),
    volumeFrom: str(f.volumeFrom),
    volumeTo: str(f.volumeTo),
    powerFrom: str(f.powerFrom),
    powerTo: str(f.powerTo),
    fuel: (Array.isArray(f.fuel) ? f.fuel : []).map(str).slice(0, 4),
  };
}

app.get("/api/subscriptions", requireUser, (req, res) => {
  res.json({ success: true, items: subscriptions.filter(sub => sub.userId === req.telegramUser.id) });
});

app.post("/api/subscriptions", requireUser, (req, res) => {
  const userId = req.telegramUser.id;
  const own = subscriptions.filter(sub => sub.userId === userId);

  if (own.length >= 5) {
    return res.status(400).json({ success: false, error: "Можно сохранить до 5 поисков — удалите один из старых" });
  }

  const sub = {
    id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    userId,
    username: req.telegramUser.username || null,
    filters: cleanFilters(req.body?.filters),
    label: String(req.body?.label || "").slice(0, 120),
    priceDrops: req.body?.priceDrops !== false,
    createdAt: new Date().toISOString(),
  };

  subscriptions.push(sub);
  saveSubscriptions();

  const matching = readCars().filter(car => car.status === "published" && subscriptionMatches(sub.filters, carFacts(car))).length;
  res.json({ success: true, item: sub, matching });
});

app.delete("/api/subscriptions/:id", requireUser, (req, res) => {
  const before = subscriptions.length;
  subscriptions = subscriptions.filter(sub => !(sub.id === req.params.id && sub.userId === req.telegramUser.id));

  if (subscriptions.length === before) {
    return res.status(404).json({ success: false, error: "Подписка не найдена" });
  }

  saveSubscriptions();
  res.json({ success: true });
});

// ---------- Профиль клиента ----------

function publicProfile(userId) {
  const profile = profileOf(userId) || {};
  return {
    phone: profile.phone || "",
    email: profile.email || "",
    city: profile.city || "",
    notifications: profile.notifications !== false,
    createdAt: profile.createdAt || null,
    phoneVerified: Boolean(profile.phoneVerified),
    emailVerified: Boolean(profile.emailVerified),
    emailVerifyAvailable: Boolean(process.env.RESEND_API_KEY),
  };
}

app.get("/api/profile", requireUser, (req, res) => {
  const userId = req.telegramUser.id;
  const own = requests
    .filter(item => item.userId === userId)
    .slice(-20)
    .reverse()
    .map(({ id, type, carId, title, summary, status, createdAt }) => ({ id, type, carId, title, summary, status, createdAt }));

  res.json({
    success: true,
    profile: publicProfile(userId),
    requests: own,
    subscriptions: subscriptions.filter(sub => sub.userId === userId),
    deals: deals.filter(deal => deal.userId === userId).reverse().map(publicDeal),
    stages: DEAL_STAGES,
  });
});

app.put("/api/profile", requireUser, (req, res) => {
  const user = req.telegramUser;
  const body = req.body || {};

  const phone = String(body.phone || "").trim().slice(0, 32);
  const phoneDigits = phone.replace(/\D/g, "");
  if (phone && (phoneDigits.length < 7 || phoneDigits.length > 15)) {
    return res.status(400).json({ success: false, field: "phone", error: "Проверьте номер телефона" });
  }

  const email = String(body.email || "").trim().toLowerCase().slice(0, 254);
  if (email && !EMAIL_RE.test(email)) {
    return res.status(400).json({ success: false, field: "email", error: "Проверьте адрес почты" });
  }

  const city = String(body.city || "").trim().replace(/\s+/g, " ").slice(0, 60);
  const key = String(user.id);
  const previous = profiles[key] || {};

  const samePhone = phone.replace(/\D/g, "") === String(previous.phone || "").replace(/\D/g, "");
  const sameEmail = email === String(previous.email || "").toLowerCase();

  profiles[key] = {
    ...previous,
    phoneVerified: Boolean(previous.phoneVerified && samePhone && phone),
    emailVerified: Boolean(previous.emailVerified && sameEmail && email),
    userId: user.id,
    firstName: user.first_name || previous.firstName || "",
    username: user.username || previous.username || "",
    phone,
    email,
    city,
    notifications: body.notifications !== false,
    createdAt: previous.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  saveProfiles();
  res.json({ success: true, profile: publicProfile(user.id) });
});

// ---------- Подтверждение почты кодом ----------

const emailCodes = new Map(); // userId -> { email, hash, expires, attempts, sentAt, sentTimes[] }
const codeSecret = crypto.createHash("sha256").update(`${token}:email-codes`).digest();

function hashCode(userId, email, code) {
  return crypto.createHmac("sha256", codeSecret).update(`${userId}:${email}:${code}`).digest("hex");
}

async function sendEmail(to, subject, html, text) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || "MICOOR CAR <noreply@micoorcar.ru>",
      to: [to],
      subject,
      html,
      text,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Ошибка отправки письма:", response.status, data?.message || data);
    return false;
  }
  return true;
}

app.post("/api/profile/email/send", requireUser, async (req, res) => {
  if (!process.env.RESEND_API_KEY) {
    return res.status(503).json({ success: false, error: "Подтверждение почты скоро заработает" });
  }

  const userId = req.telegramUser.id;
  const email = String(req.body?.email || "").trim().toLowerCase().slice(0, 254);
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ success: false, field: "email", error: "Проверьте адрес почты" });
  }

  const now = Date.now();
  const previous = emailCodes.get(userId);
  const recent = (previous?.sentTimes || []).filter(time => now - time < 60 * 60 * 1000);
  if (previous && now - previous.sentAt < 60 * 1000) {
    return res.status(429).json({ success: false, error: "Код уже отправлен. Повторно — через минуту" });
  }
  if (recent.length >= 5) {
    return res.status(429).json({ success: false, error: "Слишком много попыток. Попробуйте через час" });
  }

  const code = String(crypto.randomInt(100000, 1000000));
  const ok = await sendEmail(
    email,
    `Код подтверждения MICOOR CAR: ${code}`,
    `<div style="font-family:Arial,sans-serif;font-size:16px;color:#23261b">
      <p>Здравствуйте!</p>
      <p>Ваш код подтверждения почты в MICOOR CAR:</p>
      <p style="font-size:32px;font-weight:bold;letter-spacing:6px;color:#4c5829">${code}</p>
      <p>Код действует 10 минут. Если вы не запрашивали код — просто проигнорируйте это письмо.</p>
      <p style="color:#6b6c5c">MICOOR CAR — прямой экспорт автомобилей из Китая</p>
    </div>`,
    `Ваш код подтверждения MICOOR CAR: ${code}\nКод действует 10 минут.`
  );

  if (!ok) {
    return res.status(502).json({ success: false, error: "Не удалось отправить письмо. Проверьте адрес и попробуйте позже" });
  }

  emailCodes.set(userId, {
    email,
    hash: hashCode(userId, email, code),
    expires: now + 10 * 60 * 1000,
    attempts: 0,
    sentAt: now,
    sentTimes: [...recent, now],
  });

  res.json({ success: true });
});

app.post("/api/profile/email/verify", requireUser, (req, res) => {
  const user = req.telegramUser;
  const entry = emailCodes.get(user.id);
  const code = String(req.body?.code || "").replace(/\D/g, "");

  if (!entry || Date.now() > entry.expires) {
    return res.status(400).json({ success: false, error: "Код устарел — запросите новый" });
  }
  if (entry.attempts >= 5) {
    return res.status(400).json({ success: false, error: "Слишком много неверных попыток — запросите новый код" });
  }
  if (hashCode(user.id, entry.email, code) !== entry.hash) {
    entry.attempts += 1;
    return res.status(400).json({ success: false, error: `Неверный код. Осталось попыток: ${5 - entry.attempts}` });
  }

  emailCodes.delete(user.id);
  const key = String(user.id);
  const previous = profiles[key] || {};
  profiles[key] = {
    ...previous,
    userId: user.id,
    firstName: user.first_name || previous.firstName || "",
    username: user.username || previous.username || "",
    email: entry.email,
    emailVerified: true,
    emailVerifiedAt: new Date().toISOString(),
    createdAt: previous.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveProfiles();
  res.json({ success: true, profile: publicProfile(user.id) });
});

// ---------- Сделки: админ ведёт авто клиента ----------

function adminDisplayName(user) {
  return user.username ? `@${user.username}` : user.first_name || String(user.id);
}

app.get("/api/admin/deals", requireAdmin, (req, res) => {
  // клиенты: все, кто оставлял заявки или заполнял профиль
  const clients = new Map();
  for (const request of requests) {
    if (!request.userId) continue;
    clients.set(request.userId, { userId: request.userId, name: clientName(request.userId), last: request.title });
  }
  for (const profile of Object.values(profiles)) {
    if (!clients.has(profile.userId)) clients.set(profile.userId, { userId: profile.userId, name: clientName(profile.userId), last: "" });
  }

  res.json({
    success: true,
    stages: DEAL_STAGES,
    deals: [...deals].reverse().map(deal => ({
      ...publicDeal(deal),
      userId: deal.userId,
      client: clientName(deal.userId),
      phone: profileOf(deal.userId)?.phone || "",
      city: profileOf(deal.userId)?.city || "",
    })),
    clients: [...clients.values()].reverse().slice(0, 300),
  });
});

app.post("/api/admin/deals", requireAdmin, async (req, res) => {
  const userId = Number(req.body?.userId);
  if (!userId) return res.status(400).json({ success: false, error: "Выберите клиента" });

  const car = req.body?.carId ? readCars().find(item => String(item.id) === String(req.body.carId)) : null;
  const title = car ? carTitle(car.text) : String(req.body?.title || "").trim();
  if (!title) return res.status(400).json({ success: false, error: "Укажите автомобиль" });

  const deal = createDeal({ userId, carId: car?.id || null, title, adminName: adminDisplayName(req.telegramUser) });

  if (car && req.body?.markSold !== false && car.status === "published") {
    const cars = readCars();
    const target = cars.find(item => item.id === car.id);
    target.status = "hidden";
    target.soldAt = new Date().toISOString();
    saveCars(cars);
  }

  await notifyDealUpdate(deal, { stage: "bought", note: String(req.body?.note || "").slice(0, 500) });
  res.json({ success: true, deal: publicDeal(deal) });
});

app.post("/api/admin/deals/:id", requireAdmin, async (req, res) => {
  const deal = deals.find(item => item.id === req.params.id);
  if (!deal) return res.status(404).json({ success: false, error: "Сделка не найдена" });

  const stage = req.body?.stage && DEAL_STAGE[req.body.stage] ? req.body.stage : null;
  const note = String(req.body?.note || "").trim().slice(0, 500);
  if (!note && (!stage || stage === deal.stage)) {
    return res.status(400).json({ success: false, error: "Выберите новый этап или напишите комментарий" });
  }

  const entry = {
    stage: stage && stage !== deal.stage ? stage : null,
    note,
    at: new Date().toISOString(),
    by: adminDisplayName(req.telegramUser),
  };
  if (entry.stage) deal.stage = entry.stage;
  deal.history.push(entry);
  deal.updatedAt = entry.at;
  saveDeals();

  const sent = await notifyDealUpdate(deal, entry);
  res.json({ success: true, deal: publicDeal(deal), notified: Boolean(sent?.ok) });
});

// ---------- Отзывы клиентов ----------

app.get("/api/reviews", (req, res) => {
  res.json(reviews.filter(review => review.status === "published").reverse().slice(0, 30).map(publicReview));
});

app.get("/api/reviews/:id/photos/:index", async (req, res) => {
  const review = reviews.find(item => item.id === req.params.id);
  const fileId = review?.photos?.[Number(req.params.index)];
  if (!review || !fileId) return res.status(404).send("Фото не найдено");
  if (review.status !== "published") {
    const user = validateInitData(req.get("X-Telegram-Init-Data"));
    if (!user || !isAdmin(user.id)) return res.status(404).send("Фото не найдено");
  }

  try {
    const fileResult = await telegram("getFile", { file_id: fileId });
    const filePath = fileResult?.result?.file_path;
    if (!filePath) return res.status(404).send("Файл не найден");
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
    if (!response.ok) return res.status(502).send("Не удалось получить фото");
    res.set("Content-Type", response.headers.get("content-type") || "image/jpeg");
    res.set("Cache-Control", "public, max-age=604800, immutable");
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error("Ошибка фото отзыва:", error);
    res.status(500).send("Ошибка сервера");
  }
});

async function uploadPhotoToTelegram(chatId, buffer, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption.slice(0, 1000));
  form.append("photo", new Blob([buffer], { type: "image/jpeg" }), "review.jpg");
  const response = await fetch(`${api}/sendPhoto`, { method: "POST", body: form });
  const data = await response.json();
  if (!data.ok) {
    console.error("Telegram API error (sendPhoto):", data.description || data);
    return null;
  }
  const sizes = data.result?.photo || [];
  return sizes[sizes.length - 1]?.file_id || null;
}

app.post("/api/reviews", requireUser, async (req, res) => {
  try {
    const user = req.telegramUser;
    const deal = deals.find(item => item.id === req.body?.dealId && item.userId === user.id);
    if (!deal) return res.status(404).json({ success: false, error: "Покупка не найдена" });
    if (deal.stage !== "arrived") return res.status(400).json({ success: false, error: "Отзыв можно оставить, когда авто приедет" });
    if (reviews.some(item => item.dealId === deal.id)) return res.status(400).json({ success: false, error: "Вы уже оставили отзыв — спасибо!" });

    const rating = Math.max(1, Math.min(5, Number(req.body?.rating) || 5));
    const text = String(req.body?.text || "").trim().slice(0, 1500);
    if (text.length < 3) return res.status(400).json({ success: false, error: "Напишите пару слов о покупке" });

    const rawPhotos = (Array.isArray(req.body?.photos) ? req.body.photos : []).slice(0, 3);
    const name = user.first_name || (user.username ? `@${user.username}` : "Клиент");
    const header = `⭐ НОВЫЙ ОТЗЫВ MICOOR CAR\n\n${"★".repeat(rating)}${"☆".repeat(5 - rating)}\n🚗 ${deal.title}\n👤 ${clientName(user.id)}\n\n${text}`;

    const photoIds = [];
    for (const [index, raw] of rawPhotos.entries()) {
      const base64 = String(raw || "").replace(/^data:image\/[a-z+]+;base64,/i, "");
      const buffer = Buffer.from(base64, "base64");
      if (buffer.length < 1000 || buffer.length > 4 * 1024 * 1024) continue;
      const fileId = await uploadPhotoToTelegram(leadsChatId, buffer, index === 0 ? `📸 Фото к отзыву: ${deal.title}` : "");
      if (fileId) photoIds.push(fileId);
    }

    const review = {
      id: `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      dealId: deal.id,
      userId: user.id,
      name,
      carTitle: deal.title,
      rating,
      text,
      photos: photoIds,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    reviews.push(review);
    saveReviews();

    await sendMessage(leadsChatId, `${header}\n\nФото: ${photoIds.length}\nОпубликовать в мини‑аппе?`, {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Опубликовать", callback_data: `review:${review.id}:published` },
          { text: "🙈 Не публиковать", callback_data: `review:${review.id}:hidden` },
        ]],
      },
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Ошибка отзыва:", error);
    res.status(500).json({ success: false, error: "Не удалось отправить отзыв" });
  }
});

// ---------- Калькулятор растаможки ----------

app.get("/api/customs", async (req, res) => {
  try {
    const result = await calculateCustoms({
      price: req.query.price,
      currency: String(req.query.currency || "CNY").toUpperCase(),
      age: String(req.query.age || "new"),
      volume: req.query.volume,
      power: req.query.power,
      fuel: String(req.query.fuel || "petrol"),
    });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error("Ошибка расчёта растаможки:", error.message);
    res.status(503).json({ success: false, error: "Не удалось получить курс ЦБ. Попробуйте через минуту." });
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

    const verifiedUser = validateInitData(req.get("X-Telegram-Init-Data"));
    const wishUserId = verifiedUser?.id || null;
    const wishSummary = ["body", "budget", "year"]
      .map(key => cleanList(safeAnswers[key]).join(", "))
      .filter(Boolean)
      .join(" · ");
    const request = addRequest({ userId: wishUserId, type: "wish", title: "Анкета подбора", summary: wishSummary });

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
      `Telegram ID: ${wishUserId || Number(userId) || "не передан"}`,
      ...profileLines(wishUserId),
      "",
      `Статус: ${REQUEST_STATUS.new}`,
    ].filter(line => line !== null).join("\n");

    const extra = requestKeyboard(request, validUsername ? cleanUsername : null);

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

  await notifySubscribers(car, "new");
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

  const oldPrice = carFacts(car).price;

  if (text) {
    car.text = text;
    car.description = text;
  }

  car.updatedAt = new Date().toISOString();

  // Цена в посте изменилась — метка «Цена снижена» и уведомления
  const newPrice = carFacts(car).price;
  let priceDropped = false;

  if (oldPrice && newPrice && newPrice < oldPrice && car.status === "published") {
    car.oldPrice = Math.max(Number(car.oldPrice) || 0, oldPrice);
    car.priceDroppedAt = car.updatedAt;
    priceDropped = true;
  } else if (oldPrice && newPrice && newPrice >= (Number(car.oldPrice) || Infinity)) {
    delete car.oldPrice;
    delete car.priceDroppedAt;
  }

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

  if (priceDropped) {
    await notifyAdmins(`📉 Цена снижена: ${carTitle(car.text)}\n${formatRub(oldPrice)} → ${formatRub(newPrice)}`);
    await notifySubscribers(car, "price", { oldPrice });
  }
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
      `🔔 Подписок на поиск: ${subscriptions.length}`,
      `🚚 Авто в пути у клиентов: ${deals.filter(deal => deal.stage !== "arrived").length}`,
      `⭐ Отзывов ждут проверки: ${reviews.filter(review => review.status === "pending").length}`,
      top.length ? "\n🔥 Самые просматриваемые:\n" + top.join("\n") : "",
      "",
      "Подробная статистика и архив — в мини-аппе.",
    ].join("\n"),
    { reply_markup: { inline_keyboard: [[webAppButton("🚚 Сделки и отслеживание", "?page=deals")], [webAppButton("🛠 Открыть мини-апп")]] } }
  );
}

// =========================
// ГЛАВНОЕ МЕНЮ БОТА
// =========================

const MENU = {
  catalog: "🚗 Каталог",
  fresh: "🔥 Новинки",
  wish: "📝 Подбор авто",
  calc: "🧮 Растаможка",
  sold: "🏁 Проданные",
  subs: "🔔 Мои подписки",
  how: "ℹ️ Как мы работаем",
  manager: "👨‍💼 Менеджер",
  admin: "🛠 Админ-панель",
};

function menuKeyboard(admin) {
  const rows = [
    [{ text: MENU.catalog }, { text: MENU.fresh }],
    [{ text: MENU.wish }, { text: MENU.calc }],
    [{ text: MENU.sold }, { text: MENU.subs }],
    [{ text: MENU.how }, { text: MENU.manager }],
  ];
  if (admin) rows.push([{ text: MENU.admin }]);
  return { reply_markup: { keyboard: rows, resize_keyboard: true, is_persistent: true } };
}

function webAppButton(text, query = "") {
  return { text, web_app: { url: `${miniAppUrl}${query}` } };
}

function shortCarLine(car) {
  const f = carFacts(car);
  const parts = [f.year, f.mileage ? `${f.mileage.toLocaleString("ru-RU")} км` : ""].filter(Boolean).join(", ");
  return `• ${f.title}${parts ? ` (${parts})` : ""}${f.price ? ` — ${formatRub(f.price)}` : ""}`;
}

function sortByDate(list) {
  return [...list].sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")));
}

async function handleMenu(chatId, fromId, text, admin) {
  const cars = readCars();
  const published = sortByDate(cars.filter(car => car.status === "published"));
  const sold = [...cars.filter(car => car.status === "hidden")]
    .sort((a, b) => String(b.soldAt || b.hiddenAt || "").localeCompare(String(a.soldAt || a.hiddenAt || "")));

  if (text === "/start" || text.startsWith("/start ") || text === "/menu") {
    await sendMessage(
      chatId,
      [
        "🚗 MICOOR CAR — прямой экспортёр авто из Китая",
        "",
        "Цены «под ключ» до Уссурийска: покупка, доставка, таможенное оформление и все сопутствующие расходы.",
        "",
        `✅ Сейчас в продаже: ${published.length}` + (sold.length ? `\n🏁 Уже продали: ${sold.length}` : ""),
        "",
        "Выберите раздел в меню ниже 👇",
      ].join("\n"),
      menuKeyboard(admin)
    );
    await sendMessage(chatId, "Или сразу откройте каталог:", catalogButton());
    return true;
  }

  if (text === MENU.catalog || text === "🚗 Каталог" || text === "/catalog") {
    const prices = published.map(car => carFacts(car).price).filter(Boolean);
    const brands = [...new Set(published.map(car => carFacts(car).brand).filter(Boolean))];
    await sendMessage(
      chatId,
      published.length
        ? [
            `🚗 В каталоге ${published.length} авто`,
            prices.length ? `💰 Цены под ключ: от ${formatRub(Math.min(...prices))} до ${formatRub(Math.max(...prices))}` : "",
            brands.length ? `🏷 Марки: ${brands.slice(0, 8).join(", ")}` : "",
            "",
            "Последние поступления:",
            ...published.slice(0, 3).map(shortCarLine),
            "",
            "В каталоге — поиск по параметрам как на Drom, фото и заявка в один тап.",
          ].filter(line => line !== null).join("\n")
        : "🚗 Каталог обновляется — новые авто появятся совсем скоро.\n\nА пока можно оставить анкету, и мы подберём машину под вас.",
      { reply_markup: { inline_keyboard: [[webAppButton("🚗 Открыть каталог")], [webAppButton("📝 Подбор под мой бюджет", "?page=wish")]] } }
    );
    return true;
  }

  if (text === MENU.fresh) {
    const fresh = published.slice(0, 5);
    if (!fresh.length) {
      await sendMessage(chatId, "🔥 Новые авто появятся здесь сразу после публикации в канале.\n\nХотите узнать первым? Оформите подписку на поиск в каталоге.", catalogButton());
      return true;
    }
    await sendMessage(
      chatId,
      ["🔥 Новые поступления", "", ...fresh.map(shortCarLine), "", "Нажмите на авто, чтобы открыть карточку 👇"].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            ...fresh.map(car => [webAppButton(`🚗 ${carFacts(car).title}`.slice(0, 60), `?car=${encodeURIComponent(car.id)}`)]),
            [webAppButton("Весь каталог →")],
          ],
        },
      }
    );
    return true;
  }

  if (text === MENU.wish || text === "📩 Оставить заявку" || text === "/podbor") {
    await sendMessage(
      chatId,
      "📝 Подбор авто под вас\n\nОтветьте на несколько коротких вопросов — кузов, бюджет, год, двигатель, марки. Менеджер подберёт варианты на рынке Китая, а вы сразу увидите, что уже есть в каталоге.\n\nЗаймёт меньше минуты.",
      { reply_markup: { inline_keyboard: [[webAppButton("📝 Заполнить анкету", "?page=wish")], [{ text: "💬 Написать менеджеру", url: "https://t.me/arturexpo" }]] } }
    );
    return true;
  }

  if (text === MENU.calc || text === "🧮 Калькулятор" || text === "/calc") {
    await sendMessage(
      chatId,
      `🧮 Калькулятор растаможки\n\nПосчитайте таможенные платежи для авто из Китая:\n• единая таможенная ставка\n• таможенный сбор\n• утильсбор\n\nПо курсу ЦБ на сегодня, ставки обновлены ${RATES_UPDATED.split("-").reverse().join(".")}.`,
      { reply_markup: { inline_keyboard: [[webAppButton("🧮 Открыть калькулятор", "?page=calc")]] } }
    );
    return true;
  }

  if (text === MENU.sold) {
    await sendMessage(
      chatId,
      sold.length
        ? [`🏁 Мы уже продали ${sold.length} авто`, "", "Последние сделки:", ...sold.slice(0, 5).map(shortCarLine), "", "Понравился какой-то? Подберём такой же."].join("\n")
        : "🏁 Здесь будет история наших продаж — с фото и характеристиками каждого авто.",
      { reply_markup: { inline_keyboard: [[webAppButton("🏁 Смотреть проданные", "?page=archive")], [webAppButton("📝 Хочу такой же", "?page=wish")]] } }
    );
    return true;
  }

  if (text === MENU.subs || text === "❤️ Избранное") {
    const own = subscriptions.filter(sub => sub.userId === fromId);
    await sendMessage(
      chatId,
      own.length
        ? ["🔔 Ваши подписки", "", ...own.map((sub, index) => `${index + 1}. ${sub.label || "Все автомобили"}${sub.priceDrops ? " · + снижение цены" : ""}`), "", "Бот напишет, как только появится подходящее авто."].join("\n")
        : "🔔 Подписок пока нет\n\nОткройте каталог, задайте фильтры (марка, бюджет, год) и нажмите «Сообщить о новых» — бот напишет, как только появится подходящее авто.",
      {
        reply_markup: {
          inline_keyboard: [
            ...own.map((sub, index) => [{ text: `❌ Удалить подписку ${index + 1}`, callback_data: `unsub:${sub.id}` }]),
            [webAppButton(own.length ? "➕ Новая подписка" : "🔔 Настроить подписку", "?page=catalog")],
            [webAppButton("👤 Мой профиль", "?page=profile"), webAppButton("❤️ Избранное", "?page=favorites")],
          ],
        },
      }
    );
    return true;
  }

  if (text === MENU.how) {
    await sendMessage(
      chatId,
      [
        "ℹ️ Как мы работаем",
        "",
        "1️⃣ Выбор — авто из каталога или подбор по вашему запросу",
        "2️⃣ Проверка — согласуем состояние, комплектацию и итоговую цену",
        "3️⃣ Покупка — выкупаем автомобиль и готовим документы",
        "4️⃣ Доставка — везём из Китая и проходим таможенное оформление",
        "5️⃣ Выдача — вы забираете авто в Уссурийске",
        "6️⃣ Доставка до дома — по желанию привезём автовозом в ваш город",
        "",
        "💰 Цена в каталоге — под ключ до Уссурийска, включая:",
        "✔️ покупку автомобиля",
        "✔️ доставку",
        "✔️ таможенное оформление",
        "✔️ все сопутствующие расходы",
      ].join("\n"),
      { reply_markup: { inline_keyboard: [[webAppButton("🚗 Смотреть авто")], [webAppButton("📝 Подобрать под меня", "?page=wish")]] } }
    );
    return true;
  }

  if (text === MENU.manager || text === "👨‍💼 Менеджер") {
    await sendMessage(
      chatId,
      "👨‍💼 Менеджер MICOOR CAR — @arturexpo\n\nОтветит на вопросы по любому авто, посчитает стоимость под ключ и подберёт варианты под ваш бюджет.",
      { reply_markup: { inline_keyboard: [[{ text: "💬 Написать менеджеру", url: "https://t.me/arturexpo" }], [webAppButton("📝 Оставить анкету", "?page=wish")]] } }
    );
    return true;
  }

  if ((text === MENU.admin || text === "/admin") && admin) {
    await sendAdminStats(chatId);
    return true;
  }

  return false;
}

async function handleSharedContact(message) {
  const contact = message.contact;
  const fromId = message.from?.id;

  if (!contact.user_id || contact.user_id !== fromId) {
    await sendMessage(message.chat.id, "Подтвердить можно только свой номер — нажмите кнопку «📱 Поделиться номером».");
    return;
  }

  const digits = String(contact.phone_number || "").replace(/\D/g, "");
  if (digits.length < 7) return;

  const key = String(fromId);
  const previous = profiles[key] || {};
  profiles[key] = {
    ...previous,
    userId: fromId,
    firstName: message.from.first_name || previous.firstName || "",
    username: message.from.username || previous.username || "",
    phone: `+${digits}`,
    phoneVerified: true,
    phoneVerifiedAt: new Date().toISOString(),
    createdAt: previous.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveProfiles();

  await sendMessage(message.chat.id, `✅ Номер +${digits} подтверждён и сохранён в профиле.`, menuKeyboard(isAdmin(fromId)));
  await sendMessage(message.chat.id, "Вернуться в профиль:", {
    reply_markup: { inline_keyboard: [[webAppButton("👤 Мой профиль", "?page=profile")]] },
  });
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const fromId = message.from?.id;
  const isPrivate = message.chat.type === "private";
  const text = message.text || "";

  if (!isPrivate) return; // в группах бот только отправляет заявки

  // Клиент поделился номером — подтверждаем, если это его собственный контакт
  if (message.contact) {
    await handleSharedContact(message);
    return;
  }

  const admin = isAdmin(fromId);

  if (text === "/start phone") {
    await sendMessage(chatId, "📱 Подтвердите номер телефона — нажмите кнопку ниже. Telegram передаст номер вашего аккаунта, вводить ничего не нужно.", {
      reply_markup: {
        keyboard: [[{ text: "📱 Поделиться номером", request_contact: true }], [{ text: "↩️ В меню" }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
    return;
  }

  if (text === "↩️ В меню") {
    await sendMessage(chatId, "Главное меню 👇", menuKeyboard(admin));
    return;
  }

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

  const menu = await handleMenu(chatId, fromId, text, admin);
  if (menu) return;

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

  const fromLeadsChat = String(callback.message?.chat?.id || "") === String(leadsChatId);

  // «Клиент купил» — создаём сделку из заявки
  if (data.startsWith("deal:")) {
    if (!fromLeadsChat && !isAdmin(callback.from?.id)) {
      await answer(callback, "Недоступно");
      return;
    }
    const item = requests.find(request => request.id === data.slice(5));
    if (!item?.userId) {
      await answer(callback, "Клиент не найден — оформите покупку в мини‑аппе");
      return;
    }
    if (item.dealId) {
      await answer(callback, "Покупка уже оформлена — ведите её в мини‑аппе: Профиль → Сделки");
      return;
    }

    const deal = createDeal({ userId: item.userId, carId: item.carId, title: item.type === "wish" ? "Автомобиль по анкете" : item.title, adminName: callback.from?.username ? `@${callback.from.username}` : callback.from?.first_name });
    item.dealId = deal.id;
    item.status = "done";
    saveRequests();

    // авто из каталога уходит в «Продано»
    const cars = readCars();
    const soldCar = item.carId ? cars.find(car => String(car.id) === String(item.carId) && car.status === "published") : null;
    if (soldCar) {
      soldCar.status = "hidden";
      soldCar.soldAt = new Date().toISOString();
      saveCars(cars);
    }
    await notifyDealUpdate(deal, { stage: "bought", note: "" });

    const username = (callback.message?.reply_markup?.inline_keyboard || []).flat().find(button => button.url)?.url?.replace("https://t.me/", "") || null;
    await telegram("editMessageText", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      text: (callback.message?.text || "").replace(/\nСтатус: .*$/s, "") + "\nСтатус: 🤝 Клиент купил — авто на отслеживании",
      ...requestKeyboard(item, username),
    });
    await answer(callback, "Покупка оформлена. Этапы — в мини‑аппе: Профиль → Сделки");
    return;
  }

  // Модерация отзывов
  if (data.startsWith("review:")) {
    if (!fromLeadsChat && !isAdmin(callback.from?.id)) {
      await answer(callback, "Недоступно");
      return;
    }
    const [, id, status] = data.split(":");
    const review = reviews.find(item => item.id === id);
    if (!review || !["published", "hidden"].includes(status)) {
      await answer(callback, "Отзыв не найден");
      return;
    }
    review.status = status;
    saveReviews();
    await telegram("editMessageText", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      text: (callback.message?.text || "").replace(/\nОпубликовать в мини‑аппе\?$/, "") + (status === "published" ? "\n\n✅ Опубликован в мини‑аппе" : "\n\n🙈 Не опубликован"),
      reply_markup: {
        inline_keyboard: [[
          status === "published"
            ? { text: "🙈 Снять с публикации", callback_data: `review:${id}:hidden` }
            : { text: "✅ Опубликовать", callback_data: `review:${id}:published` },
        ]],
      },
    });
    await answer(callback, status === "published" ? "Опубликован" : "Скрыт");
    return;
  }

  // Статус заявки — кнопки в группе заявок
  if (data.startsWith("lead:")) {
    const [, id, status] = data.split(":");
    const chatIdOfButton = String(callback.message?.chat?.id || "");
    if (chatIdOfButton !== String(leadsChatId) && !isAdmin(callback.from?.id)) {
      await answer(callback, "Недоступно");
      return;
    }

    const item = requests.find(request => request.id === id);
    if (!item || !REQUEST_STATUS[status]) {
      await answer(callback, "Заявка не найдена");
      return;
    }
    if (item.status === status) {
      await answer(callback, `Уже: ${REQUEST_STATUS[status]}`);
      return;
    }

    item.status = status;
    item.updatedAt = new Date().toISOString();
    item.updatedBy = callback.from?.username || callback.from?.first_name || String(callback.from?.id || "");
    saveRequests();

    const original = callback.message?.text || "";
    const who = callback.from?.username ? `@${callback.from.username}` : callback.from?.first_name || "менеджер";
    const newText = original.replace(/\nСтатус: .*$/s, "") + `\nСтатус: ${REQUEST_STATUS[status]} · ${who}`;
    const username = (callback.message?.reply_markup?.inline_keyboard || [])
      .flat()
      .find(button => button.url)?.url?.replace("https://t.me/", "") || null;

    await telegram("editMessageText", {
      chat_id: callback.message.chat.id,
      message_id: callback.message.message_id,
      text: newText,
      ...requestKeyboard(item, username),
    });
    await answer(callback, REQUEST_STATUS[status]);

    if (item.userId) {
      const what = item.type === "wish" ? "Ваша анкета подбора" : `Ваша заявка на ${item.title}`;
      const text = status === "work"
        ? `🟡 ${what} взята в работу.\n\nМенеджер скоро свяжется с вами.`
        : `✅ ${what} завершена.\n\nСпасибо, что выбрали MICOOR CAR!`;
      await sendMessage(item.userId, text, {
        reply_markup: { inline_keyboard: [[webAppButton("👤 Мой профиль", "?page=profile")]] },
      });
    }
    return;
  }

  // Удаление подписки — доступно любому пользователю для своих подписок
  if (data.startsWith("unsub:")) {
    const id = data.slice(6);
    const before = subscriptions.length;
    subscriptions = subscriptions.filter(sub => !(sub.id === id && sub.userId === callback.from?.id));

    if (subscriptions.length !== before) {
      saveSubscriptions();
      await answer(callback, "Подписка удалена");
      await telegram("editMessageText", {
        chat_id: callback.message.chat.id,
        message_id: callback.message.message_id,
        text: "🔔 Подписка удалена. Откройте «🔔 Мои подписки», чтобы увидеть остальные.",
      });
    } else {
      await answer(callback, "Подписка уже удалена");
    }
    return;
  }

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

// При деплое Render несколько секунд держит старую и новую копию одновременно.
// Старая по SIGTERM перестаёт опрашивать Telegram, новая спокойно ждёт.
let stopPolling = false;
process.on("SIGTERM", () => {
  stopPolling = true;
});

async function startBot() {
  console.log("MICOOCAR BOT запускается...");
  let conflictLogged = false;

  // Кнопка «Каталог» рядом с полем ввода во всех чатах с ботом
  await telegram("setChatMenuButton", {
    menu_button: { type: "web_app", text: "Каталог", web_app: { url: miniAppUrl } },
  });

  await telegram("setMyCommands", {
    commands: [
      { command: "start", description: "Главное меню" },
      { command: "menu", description: "Показать меню" },
      { command: "catalog", description: "Каталог автомобилей" },
      { command: "podbor", description: "Анкета подбора авто" },
      { command: "calc", description: "Калькулятор растаможки" },
    ],
  });

  while (!stopPolling) {
    try {
      const result = await telegram("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query", "channel_post", "edited_channel_post"],
      });

      if (!result.ok) {
        if (result.error_code === 409) {
          if (!conflictLogged) {
            console.log("⏳ Старая копия бота ещё работает (обычно при деплое) — жду, пока она остановится...");
            conflictLogged = true;
          }
          await sleep(5000);
        } else {
          await sleep(3000);
        }
        continue;
      }

      if (conflictLogged) {
        console.log("✅ Бот снова единственная копия — работаю");
        conflictLogged = false;
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
    await syncFileFromGitHub("subscriptions.json", subsFile);
    await syncFileFromGitHub("profiles.json", profilesFile);
    await syncFileFromGitHub("requests.json", requestsFile);
    await syncFileFromGitHub("deals.json", dealsFile);
    await syncFileFromGitHub("reviews.json", reviewsFile);
    loadStats();
    loadSubscriptions();
    loadProfiles();
    loadDeals();
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
  carFacts,
  subscriptionMatches,
};
