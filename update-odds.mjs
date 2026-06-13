#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const apiKey = process.env.THE_ODDS_API_KEY;
const here = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(here, "data/odds-latest.json");
const apiBase = "https://api.the-odds-api.com/v4";
const regions = "us,uk,eu";
const markets = "h2h";
const oddsFormat = "decimal";

const schedule = [
  ["m1", "Mexico", "South Africa"],
  ["m2", "South Korea", "Czechia", ["Korea Republic", "Korea Rep", "Republic of Korea"], ["Czech Republic"]],
  ["m3", "Canada", "Bosnia and Herzegovina", [], ["Bosnia-Herzegovina", "Bosnia"]],
  ["m4", "United States", "Paraguay", ["USA", "US", "United States of America"], []],
  ["m5", "Haiti", "Scotland"],
  ["m6", "Australia", "Turkey", [], ["Türkiye", "Turkiye"]],
  ["m7", "Brazil", "Morocco"],
  ["m8", "Qatar", "Switzerland"],
  ["m9", "Cote d'Ivoire", "Ecuador", ["Côte d'Ivoire", "Ivory Coast"], []],
  ["m10", "Germany", "Curacao", [], ["Curaçao"]],
  ["m11", "Netherlands", "Japan"],
  ["m12", "Sweden", "Tunisia"],
  ["m13", "Saudi Arabia", "Uruguay"],
  ["m14", "Spain", "Cape Verde", [], ["Cabo Verde"]],
  ["m15", "Iran", "New Zealand", ["IR Iran"], []],
  ["m16", "Belgium", "Egypt"],
  ["m17", "France", "Senegal"],
  ["m18", "Iraq", "Norway"],
  ["m19", "Argentina", "Algeria"],
  ["m20", "Austria", "Jordan"],
  ["m21", "Ghana", "Panama"],
  ["m22", "England", "Croatia"],
  ["m23", "Portugal", "DR Congo", [], ["Congo DR", "Democratic Republic of Congo"]],
  ["m24", "Uzbekistan", "Colombia"]
];

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function namesFor(primary, aliases = []) {
  return [primary, ...aliases].map(normalize);
}

const matchIndex = schedule.map(([id, home, away, homeAliases = [], awayAliases = []]) => ({
  id,
  home: namesFor(home, homeAliases),
  away: namesFor(away, awayAliases)
}));

function findScheduleMatch(event) {
  const home = normalize(event.home_team);
  const away = normalize(event.away_team);
  return matchIndex.find(item =>
    item.home.includes(home) && item.away.includes(away)
  ) || matchIndex.find(item =>
    item.home.includes(away) && item.away.includes(home)
  );
}

function outcomePrice(market, names, draw = false) {
  const outcome = market.outcomes.find(item => {
    const name = normalize(item.name);
    return draw ? name === "draw" : names.includes(name);
  });
  return typeof outcome?.price === "number" ? outcome.price : null;
}

function returnRate(home, draw, away) {
  if (!home || !draw || !away) return null;
  const overround = (1 / home) + (1 / draw) + (1 / away);
  return 100 / overround;
}

function marketProbability(oddsRows) {
  const validRows = oddsRows.filter(row => row.home && row.draw && row.away);
  if (!validRows.length) return null;
  const avg = key => validRows.reduce((sum, row) => sum + row[key], 0) / validRows.length;
  const homeOdds = avg("home");
  const drawOdds = avg("draw");
  const awayOdds = avg("away");
  const raw = {
    home: 1 / homeOdds,
    draw: 1 / drawOdds,
    away: 1 / awayOdds
  };
  const total = raw.home + raw.draw + raw.away;
  return {
    home: raw.home / total * 100,
    draw: raw.draw / total * 100,
    away: raw.away / total * 100
  };
}

function kellyProxy(price, probability) {
  if (!price || !probability) return null;
  const implied = 100 / price;
  return implied / probability;
}

async function api(path, params = {}) {
  const url = new URL(`${apiBase}${path}`);
  url.searchParams.set("apiKey", apiKey);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`The Odds API ${response.status}: ${body.slice(0, 220)}`);
  }
  return {
    data: await response.json(),
    headers: {
      remaining: response.headers.get("x-requests-remaining"),
      used: response.headers.get("x-requests-used"),
      last: response.headers.get("x-requests-last")
    }
  };
}

async function findWorldCupSportKey() {
  const { data } = await api("/sports/", { all: "true" });
  const candidates = data.filter(item => {
    const haystack = `${item.key} ${item.group} ${item.title} ${item.description}`.toLowerCase();
    return haystack.includes("soccer") && (
      haystack.includes("world cup") ||
      haystack.includes("fifa") ||
      haystack.includes("worldcup")
    );
  });
  return candidates.find(item => item.key === "soccer_fifa_world_cup")?.key ||
    candidates[0]?.key ||
    "soccer_fifa_world_cup";
}

async function main() {
  if (!apiKey) {
    throw new Error("缺少 THE_ODDS_API_KEY。运行前请先设置环境变量。");
  }

  const sportKey = await findWorldCupSportKey();
  const { data: events, headers } = await api(`/sports/${sportKey}/odds/`, {
    regions,
    markets,
    oddsFormat
  });

  const matches = {};
  for (const event of events) {
    const scheduleMatch = findScheduleMatch(event);
    if (!scheduleMatch) continue;

    const oddsRows = [];
    for (const bookmaker of event.bookmakers || []) {
      const h2h = bookmaker.markets?.find(market => market.key === "h2h");
      if (!h2h) continue;
      const home = outcomePrice(h2h, scheduleMatch.home);
      const draw = outcomePrice(h2h, [], true);
      const away = outcomePrice(h2h, scheduleMatch.away);
      if (!home || !draw || !away) continue;
      oddsRows.push({
        bookmaker: bookmaker.title,
        home,
        draw,
        away,
        returnRate: returnRate(home, draw, away),
        lastUpdate: bookmaker.last_update
      });
    }

    const probability = marketProbability(oddsRows);
    if (!probability || !oddsRows.length) continue;

    const avgReturn = oddsRows
      .filter(row => row.returnRate)
      .reduce((sum, row) => sum + row.returnRate, 0) / oddsRows.filter(row => row.returnRate).length;

    matches[scheduleMatch.id] = {
      apiEventId: event.id,
      apiHomeTeam: event.home_team,
      apiAwayTeam: event.away_team,
      commenceTime: event.commence_time,
      market: probability,
      model: probability,
      returnRate: avgReturn,
      odds: oddsRows.map(row => [
        row.bookmaker,
        row.home,
        row.draw,
        row.away,
        row.returnRate,
        kellyProxy(row.home, probability.home),
        kellyProxy(row.draw, probability.draw),
        kellyProxy(row.away, probability.away)
      ]),
      kelly: [
        oddsRows.reduce((sum, row) => sum + (kellyProxy(row.home, probability.home) || 0), 0) / oddsRows.length,
        oddsRows.reduce((sum, row) => sum + (kellyProxy(row.draw, probability.draw) || 0), 0) / oddsRows.length,
        oddsRows.reduce((sum, row) => sum + (kellyProxy(row.away, probability.away) || 0), 0) / oddsRows.length
      ],
      movement: oddsRows.slice(0, 7).map(row => row.home),
      note: "已接入 The Odds API 的胜平负赔率。当前模型概率先等同于市场去水概率；等接入球队实力模型后，再输出真正的投注价值判断。",
      exchange: "当前免费额度只拉胜平负主流公司赔率；Betfair 交易量/必发指数需另接 Betfair 数据。"
    };
  }

  const output = {
    meta: {
      status: "ok",
      updatedAt: new Date().toISOString(),
      creditsCostEstimate: Number(headers.last || 3),
      requestsRemaining: headers.remaining,
      requestsUsed: headers.used,
      sportKey,
      regions,
      markets,
      matchedEvents: Object.keys(matches).length
    },
    matches
  };

  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`已更新 ${Object.keys(matches).length} 场，预计本次消耗 ${output.meta.creditsCostEstimate} credits。`);
  if (headers.remaining) console.log(`剩余额度：${headers.remaining}`);
}

main().catch(async error => {
  const output = {
    meta: {
      status: "error",
      message: error.message,
      updatedAt: new Date().toISOString(),
      creditsCostEstimate: 0,
      regions,
      markets
    },
    matches: {}
  };
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(output, null, 2)}\n`);
  console.error(error.message);
  process.exitCode = 1;
});
