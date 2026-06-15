import cors from "cors";
import express from "express";

const HOST = String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";
const PORT = clampInteger(process.env.PORT, 3000, 1, 65535);
const REQUEST_TIMEOUT_MS = clampInteger(process.env.REQUEST_TIMEOUT_MS, 10000, 2000, 30000);
const DEATH_TRASH_STATUS_CACHE_TTL_MS = clampInteger(process.env.DEATH_TRASH_STATUS_CACHE_TTL_MS, 60000, 1000, 300000);

const DEATH_TRASH_STEAM_APP_ID = 941460;
const DEATH_TRASH_STEAM_URL = "https://store.steampowered.com/app/941460/Death_Trash/";
const DEATH_TRASH_GOG_URL = "https://www.gog.com/game/death_trash";
const DEATH_TRASH_ITCH_URL = "https://craftinglegends.itch.io/deathtrash";
const DEATH_TRASH_SITE_URL = "https://deathtrash.com/";
const DEATH_TRASH_DISCORD_URL = "https://discord.com/invite/deathtrash";
const DEATH_TRASH_YOUTUBE_URL = "https://www.youtube.com/c/DeathTrash";

const app = express();
const responseCache = new Map();

app.disable("x-powered-by");
app.use(cors());
app.use(express.json());

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function normalizeOptionalInteger(value, min, max) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.min(max, Math.max(min, parsed));
}

function sanitizeDisplayText(value, maxLength = 240) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function getCachedPayload(key, ttlMs) {
  const cached = responseCache.get(key);

  if (!cached) {
    return null;
  }

  if (Date.now() - cached.createdAt > ttlMs) {
    responseCache.delete(key);
    return null;
  }

  return cached.payload;
}

function setCachedPayload(key, payload) {
  responseCache.set(key, {
    payload,
    createdAt: Date.now()
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPageStatus(url, sourceLabel) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "falloutfanatics-death-trash-api/1.0",
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
      },
      redirect: "follow",
      signal: controller.signal
    });

    return {
      ok: response.ok,
      status: response.status,
      url: response.url || url
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${sourceLabel} request timed out`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchSteamCurrentPlayers(appId = DEATH_TRASH_STEAM_APP_ID) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let payload;

      try {
        const response = await fetch(
          `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appId}`,
          {
            redirect: "follow",
            signal: controller.signal
          }
        );

        if (!response.ok) {
          throw new Error(`Steam current players API returned HTTP ${response.status}`);
        }

        payload = await response.json();
      } finally {
        clearTimeout(timeoutId);
      }

      return normalizeOptionalInteger(payload?.response?.player_count, 0, 50000000);
    } catch (error) {
      lastError = error;

      if (attempt < 1) {
        await sleep(350);
      }
    }
  }

  throw lastError || new Error("Steam current players API request failed.");
}

function getStateFromStatus(ok, hasValue = true) {
  if (ok === true && hasValue) {
    return "online";
  }

  if (ok === false) {
    return "offline";
  }

  return "unknown";
}

function toHttpValueLabel(statusCode) {
  return statusCode ? `HTTP ${statusCode}` : "—";
}

async function getDeathTrashStatusPayload() {
  const cacheKey = "death-trash:status";
  const cached = getCachedPayload(cacheKey, DEATH_TRASH_STATUS_CACHE_TTL_MS);

  if (cached?.items && Array.isArray(cached.items)) {
    return {
      ...cached,
      cached: true
    };
  }

  const [
    steamPlayersResult,
    steamStorePageResult,
    gogPageResult,
    itchPageResult,
    sitePageResult,
    discordPageResult,
    youtubePageResult
  ] = await Promise.allSettled([
    fetchSteamCurrentPlayers(),
    fetchPageStatus(DEATH_TRASH_STEAM_URL, "Death Trash Steam store page"),
    fetchPageStatus(DEATH_TRASH_GOG_URL, "Death Trash GOG page"),
    fetchPageStatus(DEATH_TRASH_ITCH_URL, "Death Trash itch.io page"),
    fetchPageStatus(DEATH_TRASH_SITE_URL, "Death Trash official site"),
    fetchPageStatus(DEATH_TRASH_DISCORD_URL, "Death Trash Discord page"),
    fetchPageStatus(DEATH_TRASH_YOUTUBE_URL, "Death Trash YouTube page")
  ]);

  const steamPlayers = steamPlayersResult.status === "fulfilled" ? steamPlayersResult.value : null;
  const steamPlayersError = steamPlayersResult.status === "rejected"
    ? sanitizeDisplayText(steamPlayersResult.reason?.message || "Steam players request failed.", 180)
    : "";

  const steamStorePage = steamStorePageResult.status === "fulfilled" ? steamStorePageResult.value : null;
  const steamStorePageError = steamStorePageResult.status === "rejected"
    ? sanitizeDisplayText(steamStorePageResult.reason?.message || "Steam store request failed.", 180)
    : "";

  const gogPage = gogPageResult.status === "fulfilled" ? gogPageResult.value : null;
  const gogPageError = gogPageResult.status === "rejected"
    ? sanitizeDisplayText(gogPageResult.reason?.message || "GOG page request failed.", 180)
    : "";

  const itchPage = itchPageResult.status === "fulfilled" ? itchPageResult.value : null;
  const itchPageError = itchPageResult.status === "rejected"
    ? sanitizeDisplayText(itchPageResult.reason?.message || "itch.io page request failed.", 180)
    : "";

  const sitePage = sitePageResult.status === "fulfilled" ? sitePageResult.value : null;
  const sitePageError = sitePageResult.status === "rejected"
    ? sanitizeDisplayText(sitePageResult.reason?.message || "Official site request failed.", 180)
    : "";

  const discordPage = discordPageResult.status === "fulfilled" ? discordPageResult.value : null;
  const discordPageError = discordPageResult.status === "rejected"
    ? sanitizeDisplayText(discordPageResult.reason?.message || "Discord page request failed.", 180)
    : "";

  const youtubePage = youtubePageResult.status === "fulfilled" ? youtubePageResult.value : null;
  const youtubePageError = youtubePageResult.status === "rejected"
    ? sanitizeDisplayText(youtubePageResult.reason?.message || "YouTube page request failed.", 180)
    : "";

  const items = [
    {
      key: "steam-players",
      kind: "players",
      name: "Steam онлайн",
      sourceLabel: "Steam",
      status: getStateFromStatus(steamPlayers !== null, steamPlayers !== null),
      value: steamPlayers,
      valueLabel: steamPlayers !== null ? String(steamPlayers) : "—",
      httpStatus: null,
      url: DEATH_TRASH_STEAM_URL,
      title: "Death Trash on Steam",
      description: "Текущий онлайн Death Trash в Steam. Это число игроков в PC Steam, а не какой-либо общий серверный онлайн.",
      note: steamPlayersError ? "Steam временно не отдал число игроков." : "Число игроков получено из официального Steam current players API."
    },
    {
      key: "steam-store",
      kind: "store",
      name: "Страница Steam",
      sourceLabel: "Steam Store",
      status: getStateFromStatus(Boolean(steamStorePage?.ok)),
      value: steamStorePage?.status ?? null,
      valueLabel: toHttpValueLabel(steamStorePage?.status ?? null),
      httpStatus: steamStorePage?.status ?? null,
      url: steamStorePage?.url || DEATH_TRASH_STEAM_URL,
      title: "Death Trash on Steam",
      description: "Основная страница Death Trash в Steam с описанием игры, отзывами, системными требованиями и новостями магазина.",
      note: steamStorePageError ? "Страница Steam временно не ответила." : (steamStorePage?.ok ? "Страница Steam доступна." : "Страница Steam сейчас не подтвердила корректный ответ.")
    },
    {
      key: "gog-page",
      kind: "store",
      name: "Страница GOG",
      sourceLabel: "GOG",
      status: getStateFromStatus(Boolean(gogPage?.ok)),
      value: gogPage?.status ?? null,
      valueLabel: toHttpValueLabel(gogPage?.status ?? null),
      httpStatus: gogPage?.status ?? null,
      url: gogPage?.url || DEATH_TRASH_GOG_URL,
      title: "Death Trash on GOG",
      description: "Страница Death Trash в магазине GOG с DRM-free версией игры и основной информацией о релизе.",
      note: gogPageError ? "Страница GOG временно не ответила." : (gogPage?.ok ? "Страница GOG доступна." : "Страница GOG сейчас не подтвердила корректный ответ.")
    },
    {
      key: "itch-page",
      kind: "store",
      name: "itch.io",
      sourceLabel: "itch.io",
      status: getStateFromStatus(Boolean(itchPage?.ok)),
      value: itchPage?.status ?? null,
      valueLabel: toHttpValueLabel(itchPage?.status ?? null),
      httpStatus: itchPage?.status ?? null,
      url: itchPage?.url || DEATH_TRASH_ITCH_URL,
      title: "Death Trash on itch.io",
      description: "Страница Death Trash на itch.io с альтернативной витриной игры, описанием и дополнительной информацией от разработчиков.",
      note: itchPageError ? "Страница itch.io временно не ответила." : (itchPage?.ok ? "Страница itch.io доступна." : "Страница itch.io сейчас не подтвердила корректный ответ.")
    },
    {
      key: "official-site",
      kind: "site",
      name: "Официальный сайт",
      sourceLabel: "Death Trash",
      status: getStateFromStatus(Boolean(sitePage?.ok)),
      value: sitePage?.status ?? null,
      valueLabel: toHttpValueLabel(sitePage?.status ?? null),
      httpStatus: sitePage?.status ?? null,
      url: sitePage?.url || DEATH_TRASH_SITE_URL,
      title: "Death Trash",
      description: "Официальная страница Death Trash. Здесь обычно находится основная информация по игре, разработчикам и ключевым ссылкам проекта.",
      note: sitePageError ? "Официальный сайт временно не ответил." : (sitePage?.ok ? "Официальный сайт доступен." : "Официальный сайт сейчас не подтвердил корректный ответ.")
    },
    {
      key: "discord-page",
      kind: "community",
      name: "Discord",
      sourceLabel: "Discord",
      status: getStateFromStatus(Boolean(discordPage?.ok)),
      value: discordPage?.status ?? null,
      valueLabel: toHttpValueLabel(discordPage?.status ?? null),
      httpStatus: discordPage?.status ?? null,
      url: discordPage?.url || DEATH_TRASH_DISCORD_URL,
      title: "Death Trash Discord",
      description: "Официальный Discord Death Trash для общения с сообществом, обсуждений, новостей и обратной связи по игре.",
      note: discordPageError ? "Discord временно не ответил." : (discordPage?.ok ? "Discord доступен." : "Discord сейчас не подтвердил корректный ответ.")
    },
    {
      key: "youtube-page",
      kind: "media",
      name: "YouTube",
      sourceLabel: "YouTube",
      status: getStateFromStatus(Boolean(youtubePage?.ok)),
      value: youtubePage?.status ?? null,
      valueLabel: toHttpValueLabel(youtubePage?.status ?? null),
      httpStatus: youtubePage?.status ?? null,
      url: youtubePage?.url || DEATH_TRASH_YOUTUBE_URL,
      title: "Death Trash on YouTube",
      description: "Официальный YouTube-канал Death Trash с трейлерами, роликами по игре и материалами от разработчиков.",
      note: youtubePageError ? "YouTube временно не ответил." : (youtubePage?.ok ? "YouTube доступен." : "YouTube сейчас не подтвердил корректный ответ.")
    }
  ];

  const availableCount = items.filter((item) => item.status === "online").length;
  const offlineCount = items.filter((item) => item.status === "offline").length;
  const unknownCount = items.length - availableCount - offlineCount;
  const overallStatus = offlineCount > 0 ? "degraded" : availableCount > 0 ? "online" : "unknown";

  const payload = {
    service: "falloutfanatics-death-trash-api",
    source: "public-pages-and-steam",
    fetchedAt: new Date().toISOString(),
    cached: false,
    summary: {
      signalCount: items.length,
      availableCount,
      offlineCount,
      unknownCount,
      steamPlayers,
      overallStatus
    },
    disclaimer: "Death Trash — одиночная постапокалиптическая action RPG в раннем доступе. Эта страница показывает реальный Steam онлайн и доступность ключевых публичных страниц по игре.",
    items
  };

  setCachedPayload(cacheKey, payload);
  return payload;
}

app.get("/", (_req, res) => {
  res.type("text/plain").send("FalloutFanatics Death Trash API is running.");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "falloutfanatics-death-trash-api",
    fetchedAt: new Date().toISOString()
  });
});

app.get("/api/death-trash-status", async (_req, res) => {
  try {
    const payload = await getDeathTrashStatusPayload();
    res.json(payload);
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: "DEATH_TRASH_STATUS_FETCH_FAILED",
      message: error?.message || "Unable to build Death Trash status payload.",
      fetchedAt: new Date().toISOString()
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: "NOT_FOUND"
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Death Trash API listening on http://${HOST}:${PORT}`);
});



