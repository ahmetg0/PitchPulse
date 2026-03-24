const scroller = document.getElementById("gamesScroller");
const refreshBtn = document.getElementById("refreshBtn");
const lastUpdated = document.getElementById("lastUpdated");
const statusPill = document.getElementById("statusPill");
const loginBtn = document.getElementById("loginBtn");
const accountName = document.getElementById("accountName");
const competitionSelect = document.getElementById("competitionSelect");
const seasonSelect = document.getElementById("seasonSelect");
const scheduleSearch = document.getElementById("scheduleSearch");
const filterButtons = document.querySelectorAll(".filterBtn");
const chatHistoryList = document.getElementById("chatHistoryList");
const chatSearchInput = document.getElementById("chatSearchInput");
const chatClearAllBtn = document.getElementById("chatClearAllBtn");
const settingsBtn = document.getElementById("settingsBtn");

let competitions = [];
let seasonsByCompetition = new Map();
let selectedCompetitionId = null;
let selectedSeasonId = null;
let currentGroups = { past: [], current: [], future: [] };
let shouldScrollToCurrent = false;
let activeFilter = null;
let currentUser = null;
let allConversations = [];
const MAIN_PAGE_STATE_KEY = "mainPageState";
const SCHEDULE_CACHE_KEY = "mainPageScheduleCache";
let restoredMainPageState = null;
let favoriteLeagueId = "";
let timelineLiveSyncInFlight = false;
let restoreScrollAfterRender = 0;
const AUTO_END_AFTER_KICKOFF_MS = 3 * 60 * 60 * 1000;

async function loadFavoriteLeaguePreference() {
  favoriteLeagueId = "";
  if (!currentUser) return;

  try {
    const response = await fetch(`/api/user-favorite-league?ts=${Date.now()}`);
    if (!response.ok) return;
    const data = await response.json();
    favoriteLeagueId = String(data?.favorite_league_id || "").trim();
  } catch {
    favoriteLeagueId = "";
  }
}

function readScheduleCache() {
  try {
    const raw = sessionStorage.getItem(SCHEDULE_CACHE_KEY) || localStorage.getItem(SCHEDULE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeScheduleCache(payload) {
  if (!payload || !payload.season_id) return;

  const cachePayload = {
    season_id: String(payload.season_id || ""),
    generated_at: payload.generated_at || "",
    groups: payload.groups || { past: [], current: [], future: [] },
    games: Array.isArray(payload.games) ? payload.games : [],
    updated_at: Date.now(),
  };

  const serialized = JSON.stringify(cachePayload);
  sessionStorage.setItem(SCHEDULE_CACHE_KEY, serialized);
  localStorage.setItem(SCHEDULE_CACHE_KEY, serialized);
}

function readMainPageState() {
  try {
    const raw = localStorage.getItem(MAIN_PAGE_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function saveMainPageState() {
  if (!scroller) return;
  const payload = {
    competition_id: String(selectedCompetitionId || ""),
    season_id: String(selectedSeasonId || ""),
    search_query: String(scheduleSearch?.value || ""),
    active_filter: activeFilter || "",
    scroll_top: Number(scroller.scrollTop || 0),
    saved_at: Date.now(),
  };
  localStorage.setItem(MAIN_PAGE_STATE_KEY, JSON.stringify(payload));
}

function syncFilterButtonState() {
  filterButtons.forEach((btn) => {
    const btnFilter = btn.dataset.filter || "current";
    btn.classList.toggle("filterActive", activeFilter === btnFilter);
  });
}

function setStatus(text) {
  statusPill.textContent = text;
}

function formatTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString();
}

function formatKickoff(iso) {
  if (!iso) return "TBD";

  const kickoffDate = new Date(iso);
  if (Number.isNaN(kickoffDate.getTime())) return "TBD";

  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const datePart = kickoffDate.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: localTimeZone,
  });

  const timePart = kickoffDate.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: localTimeZone,
    timeZoneName: "short",
  });

  return `${datePart} at ${timePart}`;
}

function formatStatusLabel(status) {
  const value = String(status || "").trim();
  if (!value) return "Live";

  const normalized = value.toLowerCase();
  if (normalized === "aet") return "After Extra Time";

  return normalized
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatLiveTag(status, minute) {
  const statusLabel = formatStatusLabel(status);
  const minuteText = String(minute ?? "").trim();

  if (!minuteText || minuteText === "N/A" || minuteText === "—") {
    return statusLabel;
  }

  return `${statusLabel} • ${minuteText}'`;
}

function getLiveTagClass(status) {
  const value = String(status || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (["not_started", "notstarted", "scheduled", "created"].includes(value)) {
    return "liveTagNotStarted";
  }
  return "";
}

function normalizeStatus(status) {
  const base = String(status || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (base === "notstarted") return "not_started";
  if (base === "inprogress") return "in_progress";
  return base;
}

function shouldAutoEndByKickoff(startTime) {
  const parsed = new Date(startTime || "");
  if (Number.isNaN(parsed.getTime())) return false;
  return Date.now() - parsed.getTime() >= AUTO_END_AFTER_KICKOFF_MS;
}

function withAutoEndedStatus(game) {
  if (!game || typeof game !== "object") return game;
  if (!shouldAutoEndByKickoff(game.start_time)) return game;

  const normalized = normalizeStatus(game.status);
  if (["ended", "finished", "closed", "complete"].includes(normalized)) return game;

  return {
    ...game,
    status: "ENDED",
    minute: "—",
  };
}

function isInPlayStatus(status) {
  return [
    "live",
    "inprogress",
    "in_progress",
    "first_half",
    "second_half",
    "1st_half",
    "2nd_half",
    "half_time",
    "halftime",
    "pause",
    "extra_time",
    "1st_extra",
    "2nd_extra",
    "overtime",
    "awaiting_extra",
    "penalties",
    "penalty_shootout",
    "interrupted",
    "suspended",
    "delayed",
  ].includes(normalizeStatus(status));
}

function parseMatchClockToSeconds(value) {
  const text = String(value ?? "").trim().replace(/'/g, "");
  if (!text || text === "N/A" || text === "—") return 0;

  // Support values like 42:13 and 45+2.
  const minuteSecondMatch = text.match(/^(\d{1,3}):(\d{1,2})$/);
  if (minuteSecondMatch) {
    const minutes = Number(minuteSecondMatch[1]);
    const seconds = Number(minuteSecondMatch[2]);
    if (Number.isFinite(minutes) && Number.isFinite(seconds)) {
      return minutes * 60 + seconds;
    }
  }

  const stoppageMatch = text.match(/^(\d{1,3})\+(\d{1,2})$/);
  if (stoppageMatch) {
    const baseMinute = Number(stoppageMatch[1]);
    const addedMinute = Number(stoppageMatch[2]);
    if (Number.isFinite(baseMinute) && Number.isFinite(addedMinute)) {
      return (baseMinute + addedMinute) * 60;
    }
  }

  const numericMinute = Number(text);
  if (Number.isFinite(numericMinute)) {
    return numericMinute * 60;
  }

  return 0;
}

function shouldPreferLocalLiveClock(localGame, scheduleGame) {
  if (!localGame || !scheduleGame) return false;
  if (!isInPlayStatus(localGame.status) || !isInPlayStatus(scheduleGame.status)) return false;

  const localClock = parseMatchClockToSeconds(localGame.minute);
  const scheduleClock = parseMatchClockToSeconds(scheduleGame.minute);
  return localClock > scheduleClock;
}

function toEpochMs(value) {
  if (value === undefined || value === null || value === "") return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function getLocalGamesById() {
  try {
    const parsed = JSON.parse(localStorage.getItem("liveGames") || "[]");
    if (!Array.isArray(parsed)) return new Map();
    return new Map(
      parsed
        .filter((entry) => entry && entry.sport_event_id)
        .map((entry) => [String(entry.sport_event_id), entry])
    );
  } catch {
    return new Map();
  }
}

function mergeWithLocalFreshSnapshots(games, sourceGeneratedAt) {
  const sourceMs = toEpochMs(sourceGeneratedAt);
  const localById = getLocalGamesById();
  if (!localById.size) return Array.isArray(games) ? games : [];

  return (Array.isArray(games) ? games : []).map((game) => {
    const gameId = String(game?.sport_event_id || "").trim();
    if (!gameId) return withAutoEndedStatus(game);

    const local = localById.get(gameId);
    if (!local) return withAutoEndedStatus(game);

    const localUpdatedMs = toEpochMs(local.local_status_updated_at);
    const useTimestampPreference = localUpdatedMs > sourceMs;
    const useLiveClockPreference = shouldPreferLocalLiveClock(local, game);
    if (!useTimestampPreference && !useLiveClockPreference) return withAutoEndedStatus(game);

    const merged = {
      ...game,
      status: local.status ?? game.status,
      minute: local.minute ?? game.minute,
      score_home: local.score_home ?? game.score_home,
      score_away: local.score_away ?? game.score_away,
      local_status_updated_at: localUpdatedMs || toEpochMs(local.updated_at) || Date.now(),
    };
    merged.bucket = classifyGameBucket(merged.status, merged.start_time);
    return withAutoEndedStatus(merged);
  });
}

function classifyGameBucket(status, startTime) {
  if (shouldAutoEndByKickoff(startTime)) {
    return "past";
  }

  const value = normalizeStatus(status);
  if ([
    "live",
    "inprogress",
    "in_progress",
    "first_half",
    "second_half",
    "1st_half",
    "2nd_half",
    "half_time",
    "halftime",
    "pause",
    "extra_time",
    "1st_extra",
    "2nd_extra",
    "overtime",
    "awaiting_extra",
    "penalties",
    "penalty_shootout",
    "interrupted",
    "suspended",
    "delayed",
  ].includes(value)) {
    return "current";
  }
  if (["closed", "ended", "finished", "complete", "abandoned", "cancelled"].includes(value)) {
    return "past";
  }
  if (["not_started", "scheduled", "created", "postponed"].includes(value)) {
    return "future";
  }

  if (!startTime) return "future";
  const parsed = new Date(startTime);
  if (Number.isNaN(parsed.getTime())) return "future";
  return parsed.getTime() < Date.now() ? "past" : "future";
}

function regroupGamesByBucket(games) {
  const grouped = { past: [], current: [], future: [] };
  for (const game of Array.isArray(games) ? games : []) {
    const normalizedGame = withAutoEndedStatus(game);
    const bucket = classifyGameBucket(normalizedGame.status, normalizedGame.start_time);
    normalizedGame.bucket = bucket;
    grouped[bucket].push(normalizedGame);
  }
  return grouped;
}

function shouldSyncLikelyLiveGame(game) {
  if (!game || !game.sport_event_id) return false;

  const normalized = normalizeStatus(game.status);
  if (!["not_started", "scheduled", "created"].includes(normalized)) return false;

  const kickoff = new Date(game.start_time || "");
  if (Number.isNaN(kickoff.getTime())) return false;

  const now = Date.now();
  const windowStartMs = kickoff.getTime() - (10 * 60 * 1000);
  const windowEndMs = kickoff.getTime() + (3 * 60 * 60 * 1000);
  return now >= windowStartMs && now <= windowEndMs;
}

function extractTimelineStatusSnapshot(data) {
  if (!data || typeof data !== "object") return null;

  const statusObject =
    (data.sport_event_status && typeof data.sport_event_status === "object" && data.sport_event_status)
    || (data.sport_event?.sport_event_status && typeof data.sport_event.sport_event_status === "object" && data.sport_event.sport_event_status)
    || {};
  const clockObject = (statusObject.clock && typeof statusObject.clock === "object" && statusObject.clock) || {};

  const rawStatus = statusObject.match_status || statusObject.status || "";
  if (!String(rawStatus).trim()) return null;

  const snapshot = {
    status: String(rawStatus).trim().toUpperCase(),
  };

  const minuteValue = clockObject.played ?? statusObject.match_time ?? statusObject.minute;
  if (minuteValue !== undefined && minuteValue !== null && String(minuteValue).trim() !== "") {
    snapshot.minute = String(minuteValue).trim();
  }

  if (statusObject.home_score !== undefined && statusObject.home_score !== null) {
    snapshot.score_home = statusObject.home_score;
  }
  if (statusObject.away_score !== undefined && statusObject.away_score !== null) {
    snapshot.score_away = statusObject.away_score;
  }

  return snapshot;
}

async function syncLikelyLiveStatusesFromTimeline(expectedSeasonId, games) {
  if (timelineLiveSyncInFlight) return;
  if (!Array.isArray(games) || games.length === 0) return;

  const candidates = games.filter(shouldSyncLikelyLiveGame).slice(0, 8);
  if (candidates.length === 0) return;

  timelineLiveSyncInFlight = true;
  try {
    const snapshots = await Promise.all(
      candidates.map(async (game) => {
        const eventId = encodeURIComponent(game.sport_event_id);
        try {
          const response = await fetch(`/api/sport-event/${eventId}/timeline?refresh=true&ts=${Date.now()}`);
          const data = await response.json().catch(() => ({}));
          if (!response.ok) return null;
          const snapshot = extractTimelineStatusSnapshot(data);
          if (!snapshot) return null;
          return { gameId: game.sport_event_id, snapshot };
        } catch {
          return null;
        }
      })
    );

    if (String(selectedSeasonId || "") !== String(expectedSeasonId || "")) return;

    let changed = false;
    const byId = new Map(
      snapshots
        .filter(Boolean)
        .map((entry) => [entry.gameId, entry.snapshot])
    );

    for (const game of games) {
      const snapshot = byId.get(game.sport_event_id);
      if (!snapshot) continue;

      for (const [key, value] of Object.entries(snapshot)) {
        if (String(game[key] ?? "") === String(value ?? "")) continue;
        game[key] = value;
        changed = true;
      }
    }

    if (!changed) return;

    currentGroups = regroupGamesByBucket(games);
    localStorage.setItem("liveGames", JSON.stringify(games));
    writeScheduleCache({
      season_id: selectedSeasonId,
      generated_at: new Date().toISOString(),
      groups: currentGroups,
      games,
    });
    applySearchAndRender(false);
  } finally {
    timelineLiveSyncInFlight = false;
  }
}

function gameCard(g) {
  const el = document.createElement("div");
  el.className = "game";
  el.style.cursor = "pointer";

  const kickoff = formatKickoff(g.start_time);

  el.innerHTML = `
    <div class="gameTop">
      <div class="liveTag ${getLiveTagClass(g.status)}">${escapeHtml(formatLiveTag(g.status, g.minute))}</div>
    </div>

    <div class="teams">
      <div class="team homeTeamCard">
        <div class="name">${escapeHtml(g.home || "Home")}</div>
        <div class="venue stadiumLine">${escapeHtml(g.venue || "")}</div>
      </div>

      <div class="score">${escapeHtml(String(g.score_home ?? 0))} - ${escapeHtml(String(g.score_away ?? 0))}</div>

      <div class="team awayTeamCard">
        <div class="name">${escapeHtml(g.away || "Away")}</div>
        <div class="venue">&nbsp;</div>
      </div>
    </div>

    <div class="minute">Kickoff: ${escapeHtml(kickoff)}</div>
  `;

  el.addEventListener("click", () => {
    saveMainPageState();
    window.location.href = `/game-detail.html?id=${encodeURIComponent(g.sport_event_id)}`;
  });

  return el;
}

function renderGames(games) {
  scroller.innerHTML = "";

  if (!games || games.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No live games found.";
    scroller.appendChild(empty);
    return;
  }

  for (const g of games) {
    scroller.appendChild(gameCard(g));
  }
}

function sectionTitle(text) {
  const title = document.createElement("div");
  title.className = "minute";
  title.style.margin = "8px 0";
  title.style.fontWeight = "700";
  title.textContent = text;
  return title;
}

function renderGroupedGames(groups) {
  scroller.innerHTML = "";

  const byStartTimeAsc = (a, b) => String(a.start_time || "").localeCompare(String(b.start_time || ""));
  const byStartTimeDesc = (a, b) => String(b.start_time || "").localeCompare(String(a.start_time || ""));
  const isPostponed = (game) => String(game.status || "").toLowerCase() === "postponed";
  const byFutureOrder = (a, b) => {
    const aPostponed = isPostponed(a);
    const bPostponed = isPostponed(b);

    if (aPostponed !== bPostponed) {
      return aPostponed ? 1 : -1;
    }

    return byStartTimeAsc(a, b);
  };

  const past = Array.isArray(groups?.past) ? [...groups.past].sort(byStartTimeAsc) : [];
  const current = Array.isArray(groups?.current) ? [...groups.current].sort(byStartTimeDesc) : [];
  const future = Array.isArray(groups?.future) ? [...groups.future].sort(byFutureOrder) : [];

  if (past.length === 0 && current.length === 0 && future.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No games found for this season.";
    scroller.appendChild(empty);
    return;
  }

  const sections = [
    ["Past Games", past, "pastSection"],
    ["Current Games", current, "currentSection"],
    ["Future Games", future, "futureSection"],
  ];

  for (const [label, games, sectionId] of sections) {
    if (games.length === 0) continue;
    const title = sectionTitle(`${label} (${games.length})`);
    title.id = sectionId;
    scroller.appendChild(title);
    for (const game of games) {
      scroller.appendChild(gameCard(game));
    }
  }
}

function matchesSearch(game, query) {
  if (!query) return true;

  const searchableText = [
    game.home,
    game.away,
    game.venue,
    game.league,
    game.country,
    formatStatusLabel(game.status),
    formatKickoff(game.start_time),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const ignoredTerms = new Set(["vs", "v", "versus"]);
  const terms = String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token && !ignoredTerms.has(token));

  if (terms.length === 0) return true;
  return terms.every((term) => searchableText.includes(term));
}

function applySearchAndRender(scrollToCurrent = false) {
  const query = String(scheduleSearch?.value || "").trim().toLowerCase();
  const filteredGroups = {
    current: currentGroups.current.filter((game) => matchesSearch(game, query)),
    future: currentGroups.future.filter((game) => matchesSearch(game, query)),
    past: currentGroups.past.filter((game) => matchesSearch(game, query)),
  };

  const displayGroups = activeFilter
    ? {
        past: activeFilter === "past" ? filteredGroups.past : [],
        current: activeFilter === "current" ? filteredGroups.current : [],
        future: activeFilter === "future" ? filteredGroups.future : [],
      }
    : filteredGroups;

  renderGroupedGames(displayGroups);
  saveMainPageState();

  if (restoreScrollAfterRender > 0) {
    const target = restoreScrollAfterRender;
    restoreScrollAfterRender = 0;
    requestAnimationFrame(() => { scroller.scrollTop = target; });
    return;
  }

  if (scrollToCurrent) {
    if (activeFilter === "past") {
      // Scroll to bottom so most-recent past games are visible
      requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
    } else if (activeFilter === "future") {
      // Scroll to top so nearest upcoming games are visible
      const futureSection = document.getElementById("futureSection");
      if (futureSection) futureSection.scrollIntoView({ block: "start" });
    } else {
      // No filter: scroll to live games, or past/future boundary if none
      const currentSection = document.getElementById("currentSection");
      if (currentSection) {
        currentSection.scrollIntoView({ block: "start" });
        return;
      }
      const futureSection = document.getElementById("futureSection");
      if (futureSection) futureSection.scrollIntoView({ block: "start" });
    }
  }
}

function fillCompetitionDropdown(items) {
  const previousValue = competitionSelect.value;
  
  competitionSelect.innerHTML = "";

  const sortedItems = [...items].sort((a, b) => {
    if (String(a.id) === String(favoriteLeagueId)) return -1;
    if (String(b.id) === String(favoriteLeagueId)) return 1;
    return 0;
  });

  for (const competition of sortedItems) {
    const option = document.createElement("option");
    option.value = competition.id;

    const isFavorite = String(competition.id) === String(favoriteLeagueId);
    option.textContent = isFavorite ? `⭐ ${competition.name}` : competition.name;
    
    competitionSelect.appendChild(option);
  }

  if (previousValue && sortedItems.some((c) => c.id === previousValue)) {
    competitionSelect.value = previousValue;
  }
}

function fillSeasonDropdown(items) {
  seasonSelect.innerHTML = "";

  for (const season of items) {
    const option = document.createElement("option");
    option.value = season.id;
    option.textContent = season.name;
    seasonSelect.appendChild(option);
  }
}

async function loadCompetitions() {
  const response = await fetch(`/api/competitions?ts=${Date.now()}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  competitions = Array.isArray(data.competitions) ? data.competitions : [];
  fillCompetitionDropdown(competitions);
}

async function loadSeasons(competitionId) {
  const cached = seasonsByCompetition.get(competitionId);
  if (cached) {
    fillSeasonDropdown(cached);
    return cached;
  }

  const response = await fetch(`/api/seasons?competition_id=${encodeURIComponent(competitionId)}&ts=${Date.now()}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  const seasons = Array.isArray(data.seasons) ? data.seasons : [];
  seasonsByCompetition.set(competitionId, seasons);
  fillSeasonDropdown(seasons);
  return seasons;
}

async function loadDefaultSelection() {
  const response = await fetch(`/api/default-selection?ts=${Date.now()}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function loadSchedule(forceRefresh = false) {
  if (!selectedSeasonId) return;

  setStatus("Loading…");
  try {
    const refreshParam = forceRefresh ? "&refresh=true" : "";
    const res = await fetch(`/api/season-schedule?season_id=${encodeURIComponent(selectedSeasonId)}${refreshParam}&ts=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const rawGames = (Array.isArray(data.games) ? data.games : []).map(withAutoEndedStatus);
    const games = mergeWithLocalFreshSnapshots(rawGames, data.generated_at);

    // Store currently displayed season games for detail page
    localStorage.setItem("liveGames", JSON.stringify(games));
    currentGroups = regroupGamesByBucket(games);
    writeScheduleCache({
      season_id: selectedSeasonId,
      generated_at: data.generated_at,
      groups: currentGroups,
      games,
    });
    shouldScrollToCurrent = true;
    applySearchAndRender(shouldScrollToCurrent);
    shouldScrollToCurrent = false;
    lastUpdated.textContent = formatTime(data.generated_at);
    setStatus("Loaded");

    syncLikelyLiveStatusesFromTimeline(selectedSeasonId, games).catch((error) => {
      console.warn("Live status sync failed:", error);
    });
  } catch (err) {
    scroller.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = `Failed to load season schedule: ${err.message}`;
    scroller.appendChild(empty);
    setStatus("Error");
  }
}

async function initializeSelectionFlow() {
  setStatus("Loading…");
  const savedState = restoredMainPageState || {};
  const cachedSchedule = readScheduleCache();

  try {
    await loadCompetitions();
    if (competitions.length === 0) {
      throw new Error("No competitions available.");
    }

    let defaultSelection = null;
    try {
      defaultSelection = await loadDefaultSelection();
    } catch (error) {
      console.warn("Failed to fetch default selection, using first available.", error);
    }

    selectedCompetitionId =
      favoriteLeagueId && competitions.some((c) => c.id === favoriteLeagueId)
        ? favoriteLeagueId
        : (defaultSelection?.competition_id && competitions.some((c) => c.id === defaultSelection.competition_id)
            ? defaultSelection.competition_id
            : (savedState?.competition_id && competitions.some((c) => c.id === savedState.competition_id)
                ? savedState.competition_id
                : competitions[0].id));

    competitionSelect.value = selectedCompetitionId;

    const seasons = await loadSeasons(selectedCompetitionId);
    if (seasons.length === 0) {
      throw new Error("No seasons found for selected competition.");
    }

    selectedSeasonId =
      savedState?.season_id && seasons.some((s) => s.id === savedState.season_id)
        ? savedState.season_id
        : (defaultSelection?.season_id && seasons.some((s) => s.id === defaultSelection.season_id)
            ? defaultSelection.season_id
            : seasons[0].id);

    seasonSelect.value = selectedSeasonId;

    const canUseCachedSchedule =
      cachedSchedule
      && String(cachedSchedule.season_id || "") === String(selectedSeasonId || "")
      && cachedSchedule.groups
      && typeof cachedSchedule.groups === "object";

    if (canUseCachedSchedule) {
      const cachedGames = (Array.isArray(cachedSchedule.games) ? cachedSchedule.games : []).map(withAutoEndedStatus);
      const mergedCachedGames = mergeWithLocalFreshSnapshots(cachedGames, cachedSchedule.generated_at);
      currentGroups = regroupGamesByBucket(mergedCachedGames);
      localStorage.setItem("liveGames", JSON.stringify(mergedCachedGames));
      shouldScrollToCurrent = false;
      applySearchAndRender(false);
      if (cachedSchedule.generated_at) {
        lastUpdated.textContent = formatTime(cachedSchedule.generated_at);
      }
      setStatus("Loaded");

      loadSchedule(false).catch((error) => {
        console.warn("Background schedule refresh failed:", error);
      });
    } else {
      await loadSchedule();
    }

    if (scheduleSearch && typeof savedState.search_query === "string") {
      scheduleSearch.value = savedState.search_query;
    }

    activeFilter = ["past", "current", "future"].includes(savedState.active_filter)
      ? savedState.active_filter
      : null;
    syncFilterButtonState();
    applySearchAndRender(false);

    const savedScrollTop = Number(savedState.scroll_top);
    if (Number.isFinite(savedScrollTop) && savedScrollTop > 0) {
      restoreScrollAfterRender = savedScrollTop;
    }

    saveMainPageState();
  } catch (error) {
    console.error("Initialization error:", error);
    scroller.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = `Failed to initialize selection flow: ${error.message}`;
    scroller.appendChild(empty);
    setStatus("Error");
  }
}

async function checkAuthStatus() {
  try {
    const res = await fetch("/api/user");
    const data = await res.json();
    
    if (data.authenticated && data.user) {
      currentUser = data.user;
      if (accountName) {
        accountName.textContent = data.user.name || "Account";
      }
      loginBtn.textContent = "Logout";
      loginBtn.onclick = () => {
        window.location.href = "/logout";
      };
    } else {
      currentUser = null;
      if (accountName) {
        accountName.textContent = "Guest";
      }
      loginBtn.textContent = "Log In";
      loginBtn.onclick = () => {
        window.location.href = "/login";
      };
    }
  } catch (err) {
    console.error("Failed to check auth status:", err);
    currentUser = null;
    if (accountName) {
      accountName.textContent = "Guest";
    }
    loginBtn.textContent = "Log In";
    loginBtn.onclick = () => {
      window.location.href = "/login";
    };
  }
}

function formatChatPreviewDate(startTime) {
  const parsed = new Date(startTime || "");
  if (Number.isNaN(parsed.getTime())) return "--/--/----";

  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  const year = parsed.getFullYear();
  return `${month}/${day}/${year}`;
}

function renderChatHistoryList(conversations) {
  if (!chatHistoryList) return;
  chatHistoryList.innerHTML = "";

  if (chatClearAllBtn) {
    chatClearAllBtn.style.display = currentUser ? "inline-flex" : "none";
    chatClearAllBtn.disabled = !currentUser || !Array.isArray(conversations) || conversations.length === 0;
  }

  if (!currentUser) {
    const hint = document.createElement("div");
    hint.className = "chatHistoryHint";
    hint.textContent = "Log in to view chat history.";
    chatHistoryList.appendChild(hint);
    return;
  }

  if (!Array.isArray(conversations) || conversations.length === 0) {
    const hint = document.createElement("div");
    hint.className = "chatHistoryHint";
    hint.textContent = "No chats found.";
    chatHistoryList.appendChild(hint);
    return;
  }

  let renderedCount = 0;

  for (const conversation of conversations) {
    const gameId = String(conversation?.sport_event_id || "").trim();
    if (!gameId) continue;

    const card = document.createElement("div");
    card.className = "chatHistoryCard";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "chatHistoryItem";

    const homeTeam = conversation.home_team || "Team";
    const awayTeam = conversation.away_team || "Team";
    const dateStr = formatChatPreviewDate(conversation.start_time);

    const teamsEl = document.createElement("span");
    teamsEl.className = "chatItemTeams";
    teamsEl.textContent = `${homeTeam} vs ${awayTeam}`;

    const dateEl = document.createElement("span");
    dateEl.className = "chatItemDate";
    dateEl.textContent = dateStr;

    button.appendChild(teamsEl);
    button.appendChild(dateEl);

    button.addEventListener("click", () => {
      saveMainPageState();
      window.location.href = `/game-detail.html?id=${encodeURIComponent(gameId)}`;
    });

    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "chatHistoryMoreBtn";
    moreBtn.textContent = "⋯";
    moreBtn.setAttribute("aria-label", `More actions for ${homeTeam} vs ${awayTeam}`);
    moreBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      const willOpen = !card.classList.contains("chatHistoryMenuOpen");
      closeChatHistoryMenus();
      if (willOpen) {
        card.classList.add("chatHistoryMenuOpen");
      }
    });

    const menu = document.createElement("div");
    menu.className = "chatHistoryMenu";

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "chatHistoryMenuItem";
    deleteBtn.textContent = "Delete";
    deleteBtn.setAttribute("aria-label", `Delete chat for ${homeTeam} vs ${awayTeam}`);
    deleteBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      await deleteChatHistoryItem(gameId);
    });

    menu.appendChild(deleteBtn);

    card.appendChild(button);
    card.appendChild(moreBtn);
    card.appendChild(menu);
    chatHistoryList.appendChild(card);
    renderedCount += 1;
  }

  if (renderedCount === 0) {
    const hint = document.createElement("div");
    hint.className = "chatHistoryHint";
    hint.textContent = "No chats found.";
    chatHistoryList.appendChild(hint);
  }
}

function closeChatHistoryMenus() {
  const openMenus = document.querySelectorAll(".chatHistoryCard.chatHistoryMenuOpen");
  openMenus.forEach((menuCard) => {
    menuCard.classList.remove("chatHistoryMenuOpen");
  });
}

function getActiveChatSearchQuery() {
  return String(chatSearchInput?.value || "").trim();
}

function renderChatHistoryWithActiveQuery() {
  const query = getActiveChatSearchQuery();
  if (!query) {
    renderChatHistoryList(allConversations);
    return;
  }
  filterChatHistory(query);
}

function renewChatSessionForGame(sportEventId) {
  const eventId = String(sportEventId || "").trim();
  if (!eventId) return;

  let sessions = {};
  try {
    sessions = JSON.parse(localStorage.getItem("chatSessions") || "{}") || {};
  } catch {
    sessions = {};
  }

  const previousId = String(sessions[eventId] || "");
  let nextId = String(Math.floor(Math.random() * 1000000000));
  while (!nextId || nextId === previousId) {
    nextId = String(Math.floor(Math.random() * 1000000000));
  }

  sessions[eventId] = nextId;
  localStorage.setItem("chatSessions", JSON.stringify(sessions));
}

async function deleteChatHistoryItem(sportEventId) {
  if (!currentUser) return;

  const eventId = String(sportEventId || "").trim();
  if (!eventId) return;

  try {
    const response = await fetch(`/api/chat-history/${encodeURIComponent(eventId)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    renewChatSessionForGame(eventId);

    allConversations = allConversations.filter(
      (conversation) => String(conversation?.sport_event_id || "").trim() !== eventId
    );
    closeChatHistoryMenus();
    renderChatHistoryWithActiveQuery();
  } catch (error) {
    console.error("Failed to delete chat history item:", error);
  }
}

async function clearAllChatHistory() {
  if (!currentUser) return;
  if (!Array.isArray(allConversations) || allConversations.length === 0) return;

  const confirmed = window.confirm("Clear all chat history?");
  if (!confirmed) return;

  try {
    const response = await fetch("/api/chat-history", { method: "DELETE" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    allConversations = [];
    renderChatHistoryWithActiveQuery();
  } catch (error) {
    console.error("Failed to clear chat history:", error);
  }
}

function filterChatHistory(query) {
  if (!query) {
    renderChatHistoryList(allConversations);
    return;
  }
  const q = query.toLowerCase();
  const filtered = allConversations.filter((c) => {
    const home = String(c.home_team || "").toLowerCase();
    const away = String(c.away_team || "").toLowerCase();
    const dateStr = formatChatPreviewDate(c.start_time).toLowerCase();
    const preview = String(c.preview || "").toLowerCase();
    return home.includes(q) || away.includes(q) || dateStr.includes(q) || preview.includes(q);
  });
  renderChatHistoryList(filtered);
}

async function loadChatHistoryList() {
  if (!chatHistoryList) return;
  if (!currentUser) {
    renderChatHistoryList([]);
    return;
  }

  try {
    const response = await fetch(`/api/chat-history?ts=${Date.now()}`, {
      cache: "no-store",
    });
    if (!response.ok) {
      renderChatHistoryList([]);
      return;
    }

    const data = await response.json();
    allConversations = Array.isArray(data.conversations) ? data.conversations : [];
    renderChatHistoryList(allConversations);
  } catch (error) {
    console.error("Failed to load chat history:", error);
    allConversations = [];
    renderChatHistoryList([]);
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

competitionSelect.addEventListener("change", async () => {
  selectedCompetitionId = competitionSelect.value;
  selectedSeasonId = null;

  try {
    const seasons = await loadSeasons(selectedCompetitionId);
    selectedSeasonId = seasons.length > 0 ? seasons[0].id : null;
    seasonSelect.value = selectedSeasonId || "";
    await loadSchedule();
    saveMainPageState();
  } catch (error) {
    console.error("Failed to update competition selection:", error);
    setStatus("Error");
  }
});

seasonSelect.addEventListener("change", async () => {
  selectedSeasonId = seasonSelect.value;
  await loadSchedule();
  saveMainPageState();
});

settingsBtn.addEventListener("click", () => {
  window.location.href = "/settings.html";
});

if (chatSearchInput) {
  chatSearchInput.addEventListener("input", () => {
    filterChatHistory(chatSearchInput.value.trim());
  });
}

if (chatClearAllBtn) {
  chatClearAllBtn.addEventListener("click", clearAllChatHistory);
}

document.addEventListener("click", closeChatHistoryMenus);

if (scheduleSearch) {
  scheduleSearch.addEventListener("input", () => {
    applySearchAndRender();
    saveMainPageState();
  });
}

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const selected = button.dataset.filter || "current";
    activeFilter = activeFilter === selected ? null : selected;

    syncFilterButtonState();

    if (!activeFilter) {
      const prevFilter = selected;
      applySearchAndRender(false);
      requestAnimationFrame(() => {
        const currentSection = document.getElementById("currentSection");
        if (currentSection) { currentSection.scrollIntoView({ block: "start" }); return; }
        const futureSection = document.getElementById("futureSection");
        if (futureSection) futureSection.scrollIntoView({ block: "start" });
      });
    } else {
      applySearchAndRender(true);
    }

    saveMainPageState();
  });
});

if (scroller) {
  scroller.addEventListener("scroll", () => {
    saveMainPageState();
  });
}

refreshBtn.addEventListener("click", () => loadSchedule(true));

async function initializeMainPage() {
  restoredMainPageState = readMainPageState();
  await checkAuthStatus();
  await loadFavoriteLeaguePreference();
  await loadChatHistoryList();
  await initializeSelectionFlow();
}

function rehydrateScheduleFromLocalStorage() {
  try {
    const raw = localStorage.getItem("liveGames");
    if (!raw) return false;

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return false;

    const mergedGames = mergeWithLocalFreshSnapshots(parsed, 0);
    currentGroups = regroupGamesByBucket(mergedGames);
    const savedScrollTop = Number(restoredMainPageState?.scroll_top || 0);
    if (Number.isFinite(savedScrollTop) && savedScrollTop > 0) {
      restoreScrollAfterRender = savedScrollTop;
    }
    applySearchAndRender(false);

    if (selectedSeasonId) {
      writeScheduleCache({
        season_id: selectedSeasonId,
        generated_at: new Date().toISOString(),
        groups: currentGroups,
        games: mergedGames,
      });
    }

    setStatus("Loaded");
    return true;
  } catch {
    return false;
  }
}

window.addEventListener("pageshow", async (event) => {
  await checkAuthStatus();
  await loadChatHistoryList();

  if (event.persisted) {
    // Restored from bfcache (back/forward navigation) — DOM and scroll are already intact.
    // Just refresh auth UI and chat list; don't re-render or touch scroll.
    return;
  }

  const restored = rehydrateScheduleFromLocalStorage();
  if (restored && selectedSeasonId) {
    loadSchedule(false).catch((error) => {
      console.warn("Background schedule refresh on pageshow failed:", error);
    });
  }
});

initializeMainPage();
