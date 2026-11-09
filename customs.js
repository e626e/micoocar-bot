// =========================================================
// Расчёт таможенных платежей для физлиц (личное пользование)
// Единая ставка — Решение Совета ЕЭК № 107 (как на tks.ru),
// таможенный сбор — ставки с 01.01.2026 (ПП № 1638),
// утильсбор — ПП РФ № 1291 в ред. ПП № 1713, ставки 2026 года.
// Ставки утильсбора по коммерческой шкале растут каждый 1 января — обновляйте таблицы.
// Когда правительство меняет ставки — обновите этот файл.
// =========================================================

const RATES_UPDATED = "2026-11-09";

// Единая ставка, авто до 3 лет: [до стоимости в €, % , минимум €/см³]
const ETS_NEW = [
  [8500, 0.54, 2.5],
  [16700, 0.48, 3.5],
  [42300, 0.48, 5.5],
  [84500, 0.48, 7.5],
  [169000, 0.48, 15],
  [Infinity, 0.48, 20],
];

// Единая ставка, 3–5 лет: [до объёма см³, €/см³]
const ETS_3_5 = [[1000, 1.5], [1500, 1.7], [1800, 2.5], [2300, 2.7], [3000, 3], [Infinity, 3.6]];

// Единая ставка, старше 5 лет
const ETS_5 = [[1000, 3], [1500, 3.2], [1800, 3.5], [2300, 4.8], [3000, 5], [Infinity, 5.7]];

// Таможенный сбор за таможенные операции с 1 января 2026 года
// (ПП РФ № 1637 от 28.11.2024 в ред. ПП № 1638 от 23.10.2025).
// Старая таблица ПП № 342 (775…30 000 ₽) больше не действует.
// [до таможенной стоимости ₽, сбор ₽]
const CLEARANCE_FEE = [
  [200000, 1231],
  [450000, 2462],
  [1200000, 4924],
  [2700000, 13541],
  [4200000, 18465],
  [5500000, 21344],
  [10000000, 49240],
  [Infinity, 73860],
];

// Утильсбор для личного пользования, 2026
const UTIL_PREFERENTIAL = { under3: 3400, over3: 5200 }; // до 160 л.с. и до 3,0 л

// Таблицы при мощности свыше 160 л.с.: [до мощности л.с., до 3 лет, старше 3 лет]
const UTIL_TABLES = [
  {
    maxVolume: 1000,
    rows: [[190, 307200, 568800], [220, 316800, 585600], [250, 324000, 602400], [Infinity, 345600, 602400]],
  },
  {
    maxVolume: 2000,
    rows: [
      [190, 900000, 1492800], [220, 952800, 1584000], [250, 1010400, 1677600], [280, 1142400, 1838400],
      [310, 1291200, 2011200], [340, 1459200, 2203200], [370, 1663200, 2412000], [400, 1896000, 2640000],
      [430, 2160000, 2892000], [460, 2464800, 3168000], [500, 2808000, 3468000], [Infinity, 3201600, 3796800],
    ],
  },
  {
    maxVolume: 3000,
    rows: [
      [190, 2306800, 3456000], [220, 2364000, 3501600], [250, 2402400, 3552000], [280, 2520000, 3660000],
      [310, 2620800, 3770400], [340, 2726400, 3873600], [370, 2834400, 3981600], [400, 2949600, 4094400],
      [430, 3067200, 4209600], [460, 3189600, 4327200], [500, 3316800, 4447200], [Infinity, 3448800, 4572000],
    ],
  },
  {
    maxVolume: 3500,
    rows: [
      [160, 2584000, 3956200], [190, 2635200, 4000800], [220, 2688000, 4044000], [250, 2743200, 4087200],
      [280, 2810400, 4144800], [310, 2880000, 4248000], [340, 3038400, 4356000], [370, 3206400, 4485600],
      [400, 3384000, 4620000], [430, 3568800, 4759200], [460, 3765600, 4900800], [500, 3972000, 5049600],
      [Infinity, 4190400, 5200800],
    ],
  },
  {
    maxVolume: Infinity,
    rows: [
      [160, 3290600, 4325800], [190, 3345600, 4389600], [220, 3403200, 4456800], [250, 3460800, 4524000],
      [280, 3530400, 4627200], [310, 3600000, 4732800], [340, 3727200, 4992000], [370, 3857600, 5268000],
      [400, 3993600, 5558400], [430, 4132800, 5863200], [460, 4276800, 6187200], [500, 4425600, 6528000],
      [Infinity, 4581600, 6885600],
    ],
  },
];

// ---------- Курс ЦБ РФ ----------

let ratesCache = null;

async function getCbrRates() {
  if (ratesCache && Date.now() - ratesCache.loadedAt < 6 * 3600e3) return ratesCache;

  const response = await fetch("https://www.cbr-xml-daily.ru/daily_json.js");
  if (!response.ok) throw new Error(`ЦБ: ${response.status}`);

  const data = await response.json();
  const rate = (code) => data.Valute[code].Value / data.Valute[code].Nominal;

  ratesCache = {
    EUR: rate("EUR"),
    USD: rate("USD"),
    CNY: rate("CNY"),
    RUB: 1,
    date: String(data.Date || "").slice(0, 10),
    loadedAt: Date.now(),
  };

  return ratesCache;
}

function bracket(table, value) {
  return table.find((row) => value <= row[0]);
}

function utilFee(volume, power, under3) {
  if (power <= 160 && volume <= 3000) {
    return { amount: under3 ? UTIL_PREFERENTIAL.under3 : UTIL_PREFERENTIAL.over3, preferential: true };
  }

  const table = UTIL_TABLES.find((item) => volume <= item.maxVolume);
  const row = table.rows.find((item) => power <= item[0]) || table.rows[table.rows.length - 1];
  return { amount: under3 ? row[1] : row[2], preferential: false };
}

// price — цена авто в валюте currency; age: "new" (до 3 лет), "3-5", "5+"
async function calculateCustoms({ price, currency = "CNY", age = "new", volume, power, fuel = "petrol" }) {
  const rates = await getCbrRates();
  const cur = ["CNY", "USD", "EUR", "RUB"].includes(currency) ? currency : "CNY";

  const priceValue = Math.max(0, Number(price) || 0);
  const volumeValue = Math.max(0, Math.round(Number(volume) || 0));
  const powerValue = Math.max(0, Math.round(Number(power) || 0));

  if (fuel === "electric") {
    return {
      supported: false,
      reason: "Для электромобилей расчёт отличается (пошлина 15%, НДС и акциз по мощности) — его сделает менеджер.",
      rates: { EUR: rates.EUR, CNY: rates.CNY, USD: rates.USD, date: rates.date },
    };
  }

  if (!priceValue || !volumeValue || !powerValue) {
    return { supported: false, reason: "Укажите цену, объём двигателя и мощность." };
  }

  const customsValueRub = priceValue * rates[cur];
  const customsValueEur = customsValueRub / rates.EUR;

  let dutyEur;
  let dutyRule;

  if (age === "new") {
    const [, percent, minPerCm3] = bracket(ETS_NEW, customsValueEur);
    const byPercent = customsValueEur * percent;
    const byVolume = volumeValue * minPerCm3;
    dutyEur = Math.max(byPercent, byVolume);
    dutyRule = byPercent >= byVolume
      ? `${Math.round(percent * 100)}% от стоимости`
      : `минимум ${minPerCm3} €/см³`;
  } else {
    const table = age === "3-5" ? ETS_3_5 : ETS_5;
    const [, perCm3] = bracket(table, volumeValue);
    dutyEur = volumeValue * perCm3;
    dutyRule = `${perCm3} €/см³`;
  }

  const duty = dutyEur * rates.EUR;
  const fee = bracket(CLEARANCE_FEE, customsValueRub)[1];
  const util = utilFee(volumeValue, powerValue, age === "new");

  return {
    supported: true,
    currency: cur,
    customsValueRub: Math.round(customsValueRub),
    duty: Math.round(duty),
    dutyEur: Math.round(dutyEur),
    dutyRule,
    fee,
    util: util.amount,
    utilPreferential: util.preferential,
    total: Math.round(duty + fee + util.amount),
    hybridNote: fuel === "hybrid",
    rates: { EUR: rates.EUR, CNY: rates.CNY, USD: rates.USD, date: rates.date },
    ratesUpdated: RATES_UPDATED,
  };
}

module.exports = { calculateCustoms, utilFee, RATES_UPDATED };
