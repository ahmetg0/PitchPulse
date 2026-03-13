const gameContent = document.getElementById("gameContent");
const statusPill = document.getElementById("statusPill");
const leagueName = document.getElementById("leagueName");
const kickoffDate = document.getElementById("kickoffDate");
const backBtn = document.getElementById("backBtn");
const refreshBtn = document.getElementById("refreshBtn");
const loginBtn = document.getElementById("loginBtn");
const statsSection = document.getElementById("statsSection");
const timelineTab = document.getElementById("timelineTab");
const seasonStandingsTab = document.getElementById("seasonStandingsTab");
const startingLineupTab = document.getElementById("startingLineupTab");
const lineupTab = document.getElementById("lineupTab");
const timelineContent = document.getElementById("timelineContent");
const seasonStandingsContent = document.getElementById("seasonStandingsContent");
const startingLineupContent = document.getElementById("startingLineupContent");
const lineupContent = document.getElementById("lineupContent");
const matchContextPanel = document.getElementById("matchContextPanel");
const periodTotalsPanel = document.getElementById("periodTotalsPanel");
const gameStatusTop = document.getElementById("gameStatus");
const chatInput = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const chatbotContent = document.getElementById("chatbotContent");

let currentGame = null;
let sessionId = null;
let currentUser = null;
let statsTabsInitialized = false;
let cachedLineupEventId = "";
let cachedPlayersPayload = [];
let cachedTimelineEvents = [];
const timelineFilterSelections = new Map();
const TIMELINE_DEFAULT_SELECTED_FILTER_KEYS = new Set([
  "yellow_card",
  "red_card",
  "injury",
  "injury_return",
  "score_change",
  "substitution",
]);
const AUTO_END_AFTER_KICKOFF_MS = 3 * 60 * 60 * 1000;

const N8N_WEBHOOK_URL = "http://localhost:5678/webhook/23530c41-d8d2-4283-b1d9-36e725caf70a";

function generateSessionId() {
  return Math.floor(Math.random() * 1000000000);
}

function initializeSession(gameId) {
  if (!gameId) return;
  
  // Check if we already have a sessionId for this game
  const storedSessions = JSON.parse(localStorage.getItem("chatSessions") || "{}");
  
  if (storedSessions[gameId]) {
    sessionId = storedSessions[gameId];
  } else {
    // Create a new session for this game
    sessionId = generateSessionId();
    storedSessions[gameId] = sessionId;
    localStorage.setItem("chatSessions", JSON.stringify(storedSessions));
  }
}

function setStatus(text) {
  statusPill.textContent = text;
}

function formatKickoff(iso) {
  if (!iso) return "TBD";

  const kickoffDateValue = new Date(iso);
  if (Number.isNaN(kickoffDateValue.getTime())) return "TBD";

  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const datePart = kickoffDateValue.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: localTimeZone,
  });

  const timePart = kickoffDateValue.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: localTimeZone,
    timeZoneName: "short",
  });

  return `${datePart} at ${timePart}`;
}

function updateChatAccessUI() {
  const isAuthenticated = Boolean(currentUser);
  if (chatInput) {
    chatInput.disabled = !isAuthenticated;
    chatInput.placeholder = isAuthenticated
      ? "Type your question..."
      : "Log in to use game chat";
  }
  if (sendBtn) {
    sendBtn.disabled = !isAuthenticated;
  }
}

function formatStatusLabel(status) {
  const value = String(status || "").trim();
  if (!value) return "Live";

  const aliasMap = {
    notstarted: "not_started",
    inprogress: "in_progress",
  };

  const normalizedBase = value.toLowerCase().replace(/[\s-]+/g, "_");
  const normalized = aliasMap[normalizedBase] || normalizedBase;
  if (normalized === "aet") return "After Extra Time";

  return normalized
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getLiveTagClass(status) {
  const normalized = String(status || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (["not_started", "notstarted", "scheduled", "created"].includes(normalized)) {
    return "liveTagNotStarted";
  }
  return "";
}

function normalizeStatusValue(status) {
  return String(status || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function shouldAutoEndByKickoff(startTime) {
  const kickoff = new Date(startTime || "");
  if (Number.isNaN(kickoff.getTime())) return false;
  return Date.now() - kickoff.getTime() >= AUTO_END_AFTER_KICKOFF_MS;
}

function withAutoEndedStatus(game) {
  if (!game || typeof game !== "object") return game;
  if (!shouldAutoEndByKickoff(game.start_time)) return game;

  const normalized = normalizeStatusValue(game.status);
  if (["ended", "finished", "closed", "complete"].includes(normalized)) return game;

  return {
    ...game,
    status: "ENDED",
    minute: "—",
  };
}

function shouldForceTimelineRefreshForStatus(game) {
  if (!game) return false;
  if (shouldAutoEndByKickoff(game.start_time)) return false;

  const normalizedStatus = normalizeStatusValue(game.status);
  const isPreMatch = ["not_started", "notstarted", "scheduled", "created"].includes(normalizedStatus);
  if (!isPreMatch) return false;

  const kickoff = new Date(game.start_time || "");
  if (Number.isNaN(kickoff.getTime())) return false;

  // If kickoff is near/past and status is still pre-match, force a fresh timeline call.
  const staleThresholdMs = 5 * 60 * 1000;
  return Date.now() >= kickoff.getTime() - staleThresholdMs;
}

function updateGameStatusHeader(game) {
  if (!gameStatusTop || !game) return;

  const minuteRaw = String(game.minute ?? "").trim();
  const showMinute = minuteRaw && minuteRaw !== "N/A" && minuteRaw !== "—";
  const statusText = formatStatusLabel(game.status) + (showMinute ? ` • ${minuteRaw}'` : "");
  gameStatusTop.innerHTML = `<span class="liveTag ${getLiveTagClass(game.status)}">${escapeHtml(statusText)}</span>`;
}

function persistGameInStorage(updatedGame) {
  if (!updatedGame?.sport_event_id) return;

  const normalizedUpdatedGame = withAutoEndedStatus(updatedGame);

  try {
    const games = JSON.parse(localStorage.getItem("liveGames") || "[]");
    if (!Array.isArray(games) || games.length === 0) return;

    const index = games.findIndex((g) => g?.sport_event_id === normalizedUpdatedGame.sport_event_id);
    if (index < 0) return;

    games[index] = {
      ...games[index],
      ...normalizedUpdatedGame,
      local_status_updated_at: Date.now(),
    };
    localStorage.setItem("liveGames", JSON.stringify(games));
  } catch {
    // Ignore storage sync failures; UI state has already been updated.
  }
}

function extractTimelineStatusSnapshot(data) {
  if (!data || typeof data !== "object") return null;

  const statusObject =
    (data.sport_event_status && typeof data.sport_event_status === "object" && data.sport_event_status)
    || (data.sport_event?.sport_event_status && typeof data.sport_event.sport_event_status === "object" && data.sport_event.sport_event_status)
    || {};

  const clockObject = (statusObject.clock && typeof statusObject.clock === "object" && statusObject.clock) || {};

  const rawStatus = statusObject.match_status || statusObject.status || "";
  const hasStatus = String(rawStatus || "").trim() !== "";

  const snapshot = {};
  if (hasStatus) snapshot.status = String(rawStatus).trim().toUpperCase();

  const playedMinute = clockObject.played ?? statusObject.match_time ?? statusObject.minute;
  if (playedMinute !== undefined && playedMinute !== null && String(playedMinute).trim() !== "") {
    snapshot.minute = String(playedMinute).trim();
  }

  if (statusObject.home_score !== undefined && statusObject.home_score !== null) {
    snapshot.score_home = statusObject.home_score;
  }
  if (statusObject.away_score !== undefined && statusObject.away_score !== null) {
    snapshot.score_away = statusObject.away_score;
  }

  return Object.keys(snapshot).length ? snapshot : null;
}

function applyTimelineStatusSnapshot(data) {
  if (!currentGame) return;

  const snapshot = extractTimelineStatusSnapshot(data);
  if (!snapshot) return;

  let changed = false;
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) continue;
    if (String(currentGame[key] ?? "") === String(value ?? "")) continue;
    currentGame[key] = value;
    changed = true;
  }

  if (!changed) return;

  currentGame = withAutoEndedStatus(currentGame);
  updateGameStatusHeader(currentGame);

  const scoreNodes = gameContent?.querySelectorAll?.(".scoreBoard .score") || [];
  if (scoreNodes.length >= 2) {
    scoreNodes[0].textContent = String(currentGame.score_home ?? 0);
    scoreNodes[1].textContent = String(currentGame.score_away ?? 0);
  }

  persistGameInStorage(currentGame);
}

function getGameIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  console.log("[DEBUG] getGameIdFromUrl - URL params:", window.location.search, "- ID:", id);
  return id;
}

function getGameFromStorage(gameId) {
  const games = JSON.parse(localStorage.getItem("liveGames") || "[]");
  console.log("[DEBUG] getGameFromStorage - searching for ID:", gameId);
  console.log("[DEBUG] getGameFromStorage - available games in localStorage:", games);
  const game = games.find((g) => g.sport_event_id === gameId);
  return withAutoEndedStatus(game);
}

async function fetchGameContextFromHistory(gameId) {
  if (!currentUser || !gameId) return null;

  try {
    const response = await fetch(`/api/chat-history/${encodeURIComponent(gameId)}/context`);
    if (!response.ok) return null;
    const data = await response.json();
    return data?.game || null;
  } catch {
    return null;
  }
}

function displayGameDetail(game, forceTimelineRefresh = false) {
  if (!game) {
    gameContent.innerHTML = `<div class="empty">Game not found.</div>`;
    setStatus("Error");
    // statsSection.style.display = "none";
    return;
  }

  currentGame = withAutoEndedStatus(game);
  leagueName.textContent = `${escapeHtml(game.country)} • ${escapeHtml(game.league)}`;
  if (kickoffDate) {
    kickoffDate.textContent = `Kickoff: ${formatKickoff(game.start_time)}`;
  }

  updateGameStatusHeader(currentGame);

  gameContent.innerHTML = `
    <div class="gameDetailContainer">
      <div class="matchupContainer">
        <div class="team homeTeam">
          <div class="teamName">${escapeHtml(game.home || "Home")}</div>
          <div class="teamVenue">${escapeHtml(game.venue || "")}</div>
        </div>

        <div class="scoreContainer">
          <div class="scoreBoard">
            <div class="score">${escapeHtml(String(game.score_home ?? 0))}</div>
            <div class="scoreDash">-</div>
            <div class="score">${escapeHtml(String(game.score_away ?? 0))}</div>
          </div>
        </div>

        <div class="team awayTeam">
          <div class="teamName">${escapeHtml(game.away || "Away")}</div>
          <div class="teamVenue">&nbsp;</div>
        </div>
      </div>
    </div>
  `;

  // Show stats section and initialize tabs
  statsSection.style.display = "block";
  setupStatsTabs();
  setStatus("Loaded");
  // Load timeline for default active tab; standings and lineups load on tab click
  persistGameInStorage(currentGame);
  const forceRefreshFromStatus = shouldForceTimelineRefreshForStatus(currentGame);
  fetchTimeline(forceTimelineRefresh || forceRefreshFromStatus);
  fetchSeasonStandings(false);
}

async function loadGameDetail(forceTimelineRefresh = false) {
  const gameId = getGameIdFromUrl();
  console.log("[DEBUG] loadGameDetail - gameId:", gameId);

  if (!gameId) {
    gameContent.innerHTML = `<div class="empty">No game selected.</div>`;
    setStatus("Error");
    renderWelcomeChat();
    // statsSection.style.display = "none";
    return;
  }

  const game = getGameFromStorage(gameId);
  console.log("[DEBUG] loadGameDetail - game from storage:", game);
  if (game) {
    displayGameDetail(game, forceTimelineRefresh);
    loadChatMessagesForGame(gameId);
    // setupStatsTabs();
  } else {
    const fallbackGame = await fetchGameContextFromHistory(gameId);
    if (fallbackGame) {
      displayGameDetail(fallbackGame, forceTimelineRefresh);
      loadChatMessagesForGame(gameId);
      return;
    }

    gameContent.innerHTML = `<div class="empty">Game not found.</div>`;
    setStatus("Error");
    loadChatMessagesForGame(gameId);
    // statsSection.style.display = "none";
  }
}

function renderLoginRequiredChat() {
  chatbotContent.innerHTML = `
    <div class="chatbotWelcome">
      <p>Log in to use game chat.</p>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderInlineMarkdown(text) {
  let html = escapeHtml(String(text || ""));

  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  return html;
}

function renderMarkdown(text) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  const lines = source.split("\n");

  const htmlParts = [];
  let inCodeBlock = false;
  let codeLines = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      htmlParts.push("</ul>");
      inList = false;
    }
  };

  const closeCodeBlock = () => {
    if (inCodeBlock) {
      closeList();
      htmlParts.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      codeLines = [];
      inCodeBlock = false;
    }
  };

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (inCodeBlock) {
        closeCodeBlock();
      } else {
        closeList();
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    const unorderedListMatch = line.match(/^\s*[-*+]\s+(.+)$/);
    const orderedListMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    const listContent = unorderedListMatch?.[1] || orderedListMatch?.[1];

    if (listContent) {
      if (!inList) {
        htmlParts.push('<ul class="chatMarkdownList">');
        inList = true;
      }
      htmlParts.push(`<li>${renderInlineMarkdown(listContent)}</li>`);
      continue;
    }

    closeList();

    if (!line.trim()) {
      htmlParts.push('<div class="chatMarkdownSpacer"></div>');
      continue;
    }

    htmlParts.push(`<div>${renderInlineMarkdown(line)}</div>`);
  }

  closeCodeBlock();
  closeList();

  return htmlParts.join("");
}

function setupStatsTabs() {
  if (statsTabsInitialized) return;
  statsTabsInitialized = true;

  // 1. Timeline Tab
  timelineTab.addEventListener("click", () => {
    // Toggle Buttons
    timelineTab.classList.add("active");
    seasonStandingsTab.classList.remove("active");
    lineupTab.classList.remove("active");
    startingLineupTab.classList.remove("active"); // New
    
    // Toggle Content
    timelineContent.classList.add("active");
    seasonStandingsContent.classList.remove("active");
    lineupContent.classList.remove("active");
    startingLineupContent.classList.remove("active"); // New
    
    fetchTimeline();
  });

  // 2. Seasonal Standings Tab
  seasonStandingsTab.addEventListener("click", () => {
    seasonStandingsTab.classList.add("active");
    timelineTab.classList.remove("active");
    lineupTab.classList.remove("active");
    startingLineupTab.classList.remove("active"); // New

    seasonStandingsContent.classList.add("active");
    timelineContent.classList.remove("active");
    lineupContent.classList.remove("active");
    startingLineupContent.classList.remove("active"); // New

    fetchSeasonStandings();
  });

  // 3. Starting Lineup Tab (NEW)
  startingLineupTab.addEventListener("click", () => {
    startingLineupTab.classList.add("active");
    timelineTab.classList.remove("active");
    seasonStandingsTab.classList.remove("active");
    lineupTab.classList.remove("active");

    startingLineupContent.classList.add("active");
    timelineContent.classList.remove("active");
    seasonStandingsContent.classList.remove("active");
    lineupContent.classList.remove("active");

    fetchStartingLineups();
  });

  // 4. Rosters Tab (Existing lineupTab)
  lineupTab.addEventListener("click", () => {
    lineupTab.classList.add("active");
    timelineTab.classList.remove("active");
    seasonStandingsTab.classList.remove("active");
    startingLineupTab.classList.remove("active"); // New

    lineupContent.classList.add("active");
    timelineContent.classList.remove("active");
    seasonStandingsContent.classList.remove("active");
    startingLineupContent.classList.remove("active"); // New

    fetchLineups(); // Keeps calling your existing roster logic
  });
}

// ==========================================
// TIMELINE (PLAY-BY-PLAY) LOGIC
// ==========================================

async function fetchTimeline(forceRefresh = false) {
  if (!currentGame?.sport_event_id) return;
  timelineContent.innerHTML = `<div class="empty" style="color: var(--muted);">Loading timeline…</div>`;
  const eventId = encodeURIComponent(currentGame.sport_event_id);
  const refreshParam = forceRefresh ? "?refresh=true" : "";
  try {
    const res = await fetch(`/api/sport-event/${eventId}/timeline${refreshParam}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      renderMatchContextPanel(null);
      renderPeriodTotalsPanel(null);
      timelineContent.innerHTML = `<div class="empty">${data.detail || data.error || "Timeline not available for this match."}</div>`;
      return;
    }

    applyTimelineStatusSnapshot(data);

    renderMatchContextPanel(data);
    renderPeriodTotalsPanel(data);

    const events = normalizeTimelineEvents(data);
    cachedTimelineEvents = events;
    if (events.length === 0) {
      timelineContent.innerHTML = `<div class="empty">No timeline events for this match.</div>`;
      return;
    }
    timelineContent.innerHTML = renderTimeline(events);
    bindTimelineInteractions();
  } catch (err) {
    console.error("Timeline fetch error:", err);
    renderMatchContextPanel(null);
    renderPeriodTotalsPanel(null);
    timelineContent.innerHTML = `<div class="empty">Failed to load timeline.</div>`;
  }
}

function bindTimelineInteractions() {
  if (!timelineContent) return;

  reflowTimelineFilters();

  const filterActionButtons = timelineContent.querySelectorAll(".timelineFilterActionBtn");
  filterActionButtons.forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const action = String(button.dataset.filterAction || "").trim();
      if (!action) return;

      if (action === "select-all") {
        timelineFilterSelections.forEach((_, key) => timelineFilterSelections.set(key, true));
      } else if (action === "deselect-all") {
        timelineFilterSelections.forEach((_, key) => timelineFilterSelections.set(key, false));
      }

      timelineContent.innerHTML = renderTimeline(cachedTimelineEvents || []);
      bindTimelineInteractions();
    });
  });

  const filterButtons = timelineContent.querySelectorAll(".timelineFilterBtn");
  filterButtons.forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const key = String(button.dataset.filterKey || "").trim();
      if (!key) return;
      const current = timelineFilterSelections.get(key);
      timelineFilterSelections.set(key, current !== false ? false : true);
      timelineContent.innerHTML = renderTimeline(cachedTimelineEvents || []);
      bindTimelineInteractions();
    });
  });

  const rows = timelineContent.querySelectorAll(".timelineRowHasDetails");
  rows.forEach((row) => {
    row.addEventListener("click", () => {
      row.classList.toggle("timelineRowOpen");
    });
  });
}

function reflowTimelineFilters() {
  if (!timelineContent) return;

  const filterRow = timelineContent.querySelector(".timelineFilterRow");
  const chipWrap = timelineContent.querySelector(".timelineFilterChips");
  const overflowWrap = timelineContent.querySelector(".timelineFilterOverflow");
  if (!filterRow || !chipWrap || !overflowWrap) return;

  const overflowChips = Array.from(overflowWrap.querySelectorAll(".timelineFilterBtn"));
  overflowChips.forEach((chip) => chipWrap.appendChild(chip));

  const chips = Array.from(chipWrap.querySelectorAll(".timelineFilterBtn"));
  if (!chips.length) {
    overflowWrap.innerHTML = "";
    return;
  }

  const firstRowTop = chips[0].offsetTop;
  const moved = [];

  for (const chip of chips) {
    if (chip.offsetTop > firstRowTop) {
      moved.push(chip);
    }
  }

  moved.forEach((chip) => overflowWrap.appendChild(chip));
}

function normalizeTimelineEvents(data) {
  if (!data || typeof data !== "object") return [];
  let list = data.timeline;
  if (Array.isArray(list)) return list;
  if (Array.isArray(data.events)) return data.events;
  const sportEvent = data.sport_event;
  if (sportEvent && Array.isArray(sportEvent.timeline)) return sportEvent.timeline;
  if (sportEvent && Array.isArray(sportEvent.events)) return sportEvent.events;
  return [];
}

function shouldHideTimelineEvent(ev) {
  const typeValue = String(ev?.type || ev?.event_type || "").trim().toLowerCase();
  const descriptionValue = String(ev?.description || "").trim().toLowerCase();
  const normalizedText = `${typeValue} ${descriptionValue}`;
  return (
    typeValue === "match_started" ||
    typeValue === "period_start" ||
    typeValue === "period_end" ||
    typeValue === "break_start" ||
    typeValue === "break_end" ||
    typeValue === "period_score" ||
    typeValue === "end" ||
    typeValue === "match_ended" ||
    typeValue === "match end" ||
    typeValue.includes("match_end") ||
    typeValue === "injury_time_shown" ||
    typeValue === "injury time shown" ||
    typeValue.includes("injury_time") ||
    descriptionValue === "match started" ||
    descriptionValue === "match_started" ||
    descriptionValue === "match ended" ||
    descriptionValue === "match_ended" ||
    descriptionValue === "end of match" ||
    descriptionValue === "injury time shown" ||
    descriptionValue === "injury_time_shown" ||
    descriptionValue === "period_start" ||
    descriptionValue === "period_end" ||
    descriptionValue === "period start" ||
    descriptionValue === "period end" ||
    descriptionValue === "break start" ||
    descriptionValue === "break end" ||
    descriptionValue === "period score" ||
    normalizedText.includes("match ended") ||
    normalizedText.includes("match_ended") ||
    normalizedText.includes("end of match") ||
    normalizedText.includes("injury time shown") ||
    normalizedText.includes("injury_time_shown") ||
    normalizedText.includes("break start") ||
    normalizedText.includes("break end") ||
    normalizedText.includes("period score")
  );
}

function dedupeTimelineEvents(events) {
  const seen = new Set();
  const deduped = [];

  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== "object") continue;

    const stableId = String(ev.id || "").trim();
    const signature = stableId
      ? `id:${stableId}`
      : [
          String(ev.time || "").trim(),
          String(ev.match_time ?? "").trim(),
          String(ev.type || ev.event_type || "").trim().toLowerCase(),
          String(ev.description || ev.status || ev.outcome || "").trim().toLowerCase(),
          String(ev.competitor || ev.team || ev.competitor_id || "").trim().toLowerCase(),
          String(ev.home_score ?? "").trim(),
          String(ev.away_score ?? "").trim(),
        ].join("|");

    if (seen.has(signature)) continue;
    seen.add(signature);
    deduped.push(ev);
  }

  return deduped;
}

function getTimelineFilterLabel(ev) {
  return formatTimelineEventName(ev);
}

function getTimelineFilterKey(ev) {
  const label = getTimelineFilterLabel(ev);
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function renderTimelineFilters(filterTypeOrder, filterTypeLabels) {
  if (!filterTypeOrder.length) return "";

  const filterButtonsHtml = filterTypeOrder
    .map((filterKey) => {
      const label = filterTypeLabels.get(filterKey) || filterKey;
      const selected = timelineFilterSelections.get(filterKey) !== false;
      const selectedClass = selected ? "timelineFilterBtnActive" : "";
      return `<button type="button" class="timelineFilterBtn ${selectedClass}" data-filter-key="${escapeHtml(filterKey)}">${escapeHtml(label)}</button>`;
    })
    .join("");

  return `
    <div class="timelineFilterBar" role="group" aria-label="Timeline event filters">
      <div class="timelineFilterRow">
        <div class="timelineFilterChips">${filterButtonsHtml}</div>
        <div class="timelineFilterActions">
          <button type="button" class="timelineFilterActionBtn" data-filter-action="select-all">Select All</button>
          <button type="button" class="timelineFilterActionBtn" data-filter-action="deselect-all">Deselect All</button>
        </div>
      </div>
      <div class="timelineFilterOverflow"></div>
    </div>
  `;
}

function formatEventTypeLabel(typeValue) {
  return String(typeValue || "event")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTimelineEventName(ev) {
  const rawName = String(
    ev?.description || ev?.status || ev?.outcome || ev?.event_type || ev?.type || "Event"
  ).trim();
  return formatEventTypeLabel(rawName);
}

function resolveTimelineTeamName(ev) {
  const qualifierRaw = String(ev?.competitor || ev?.team || ev?.qualifier || "").trim();
  const qualifier = qualifierRaw.toLowerCase();

  if (["home", "host"].includes(qualifier)) {
    return String(currentGame?.home || "Home").trim();
  }

  if (["away", "guest", "visitor"].includes(qualifier)) {
    return String(currentGame?.away || "Away").trim();
  }

  const competitorId = String(ev?.competitor_id || ev?.competitor?.id || "").trim();
  if (competitorId) {
    const homeCompetitorId = String(currentGame?.competitor_id || "").trim();
    const awayCompetitorId = String(currentGame?.competitor2_id || "").trim();
    if (homeCompetitorId && competitorId === homeCompetitorId) {
      return String(currentGame?.home || "Home").trim();
    }
    if (awayCompetitorId && competitorId === awayCompetitorId) {
      return String(currentGame?.away || "Away").trim();
    }
  }

  if (!qualifierRaw) return "";
  return qualifierRaw.includes(":") ? qualifierRaw : formatEventTypeLabel(qualifierRaw);
}

function classifyTimelineEvent(ev) {
  const baseEventLabel = formatEventTypeLabel(ev?.type || ev?.event_type || "Event");
  const typeSignature = `${String(ev?.type || "")} ${String(ev?.event_type || "")}`.toLowerCase();
  const descriptionSignature = String(ev?.description || "").toLowerCase();
  const text = [
    ev?.type,
    ev?.event_type,
    ev?.description,
    ev?.status,
    ev?.outcome,
    ev?.method,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const isNoGoalEvent =
    /\bno\s+goal\b/.test(text) ||
    text.includes("no_goal") ||
    descriptionSignature.includes("no goal") ||
    descriptionSignature.includes("no_goal") ||
    typeSignature.includes("no_goal");
  if (isNoGoalEvent) {
    return { key: "nogoal", label: baseEventLabel };
  }

  const isScoreChangeEvent =
    /\bscore\s+change\b/.test(text) ||
    typeSignature.includes("score_change") ||
    descriptionSignature.includes("score change");
  if (isScoreChangeEvent) {
    return { key: "scorechange", label: "Score Change" };
  }

  if (typeSignature.includes("goal_kick") || text.includes("goal kick")) {
    return { key: "regular", label: formatEventTypeLabel(ev?.type || ev?.event_type || "Event") };
  }

  if (/\bgoal(s|ed)?\b/.test(text) || text.includes("own goal")) return { key: "goal", label: "Goal" };
  if (text.includes("red") || text.includes("yellow") || text.includes("card")) return { key: "card", label: "Card" };
  if (text.includes("sub") || text.includes("substitution")) return { key: "sub", label: "Sub" };
  if (text.includes("var")) return { key: "var", label: "VAR" };
  return { key: "regular", label: formatEventTypeLabel(ev?.type || ev?.event_type || "Event") };
}

function formatTimelineMinute(ev) {
  const minuteValue = ev?.match_time ?? ev?.minute;
  if (minuteValue !== undefined && minuteValue !== null && String(minuteValue).trim() !== "") {
    return `${escapeHtml(String(minuteValue))}'`;
  }

  const stoppage = ev?.stoppage_time;
  if (stoppage !== undefined && stoppage !== null && String(stoppage).trim() !== "") {
    return `+${escapeHtml(String(stoppage))}`;
  }

  if (ev?.time) {
    const parsed = new Date(ev.time);
    if (!Number.isNaN(parsed.getTime())) {
      return escapeHtml(
        parsed.toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
        })
      );
    }
  }

  return "—";
}

function renderEventDetails(ev) {
  const players = Array.isArray(ev?.players) ? ev.players : [];
  const playerLines = players
    .map((player) => {
      const name = String(player?.name || "").trim();
      if (!name) return "";
      const role = String(player?.type || "").trim();
      return role ? `${name} (${role.replace(/_/g, " ")})` : name;
    })
    .filter(Boolean);

  const commentaries = Array.isArray(ev?.commentaries)
    ? ev.commentaries
        .map((entry) => String(entry?.text || "").trim())
        .filter(Boolean)
    : [];

  const hasScore =
    ev?.home_score !== undefined && ev?.home_score !== null && String(ev.home_score).trim() !== "" &&
    ev?.away_score !== undefined && ev?.away_score !== null && String(ev.away_score).trim() !== "";

  const scoreText = hasScore ? `${String(ev.home_score)} - ${String(ev.away_score)}` : "";
  const playerText = playerLines.join(" • ");
  const commentaryText = commentaries.length ? commentaries.join(" ") : "";

  const playersRow = playerText
    ? `<div class="timelineHoverRow"><strong>Players:</strong> ${escapeHtml(playerText)}</div>`
    : "";
  const commentaryRow = commentaryText
    ? `<div class="timelineHoverRow"><strong>Commentary:</strong> ${escapeHtml(commentaryText)}</div>`
    : "";
  const scoreRow = scoreText
    ? `<div class="timelineHoverRow"><strong>Score:</strong> ${escapeHtml(scoreText)}</div>`
    : "";

  const detailRows = [playersRow, commentaryRow, scoreRow].filter(Boolean);
  if (detailRows.length === 0) {
    return { hasDetails: false, html: "" };
  }

  return {
    hasDetails: true,
    html: `
    <div class="timelineDetails">
      ${detailRows.join("")}
    </div>
  `,
  };
}

function renderTimeline(events) {
  const filteredEvents = dedupeTimelineEvents(events).filter((ev) => !shouldHideTimelineEvent(ev));
  const filterTypeOrder = [];
  const filterTypeLabels = new Map();

  for (const ev of filteredEvents) {
    const filterKey = getTimelineFilterKey(ev);
    if (!filterKey) continue;
    if (!filterTypeLabels.has(filterKey)) {
      filterTypeOrder.push(filterKey);
      filterTypeLabels.set(filterKey, getTimelineFilterLabel(ev));
    }
    if (!timelineFilterSelections.has(filterKey)) {
      timelineFilterSelections.set(
        filterKey,
        TIMELINE_DEFAULT_SELECTED_FILTER_KEYS.has(filterKey)
      );
    }
  }

  const visibleEvents = filteredEvents.filter((ev) => {
    const filterKey = getTimelineFilterKey(ev);
    if (!filterKey) return true;
    return timelineFilterSelections.get(filterKey) !== false;
  });

  let previousScoreSnapshot = "";

  const rows = visibleEvents.map((ev) => {
    const minuteLabel = formatTimelineMinute(ev);
    const eventType = classifyTimelineEvent(ev);
    const description = formatTimelineEventName(ev);
    const normalizedDescription = description.toLowerCase();
    const normalizedTypeText = String(ev?.type || ev?.event_type || "").toLowerCase();
    const competitorLabel = resolveTimelineTeamName(ev);
    const detailPayload = renderEventDetails(ev);

    const hasScores =
      ev?.home_score !== undefined &&
      ev?.home_score !== null &&
      String(ev.home_score).trim() !== "" &&
      ev?.away_score !== undefined &&
      ev?.away_score !== null &&
      String(ev.away_score).trim() !== "";
    const scoreSnapshot = hasScores ? `${String(ev.home_score)}-${String(ev.away_score)}` : "";
    const isFirstKnownScoreChange = Boolean(
      scoreSnapshot &&
      !previousScoreSnapshot &&
      scoreSnapshot !== "0-0"
    );
    const isScoreChange = Boolean(
      scoreSnapshot &&
      ((previousScoreSnapshot && scoreSnapshot !== previousScoreSnapshot) || isFirstKnownScoreChange)
    );
    const isNamedScoreChange =
      normalizedDescription === "score change" ||
      normalizedTypeText.includes("score_change") ||
      normalizedTypeText.includes("score change");
    if (scoreSnapshot) {
      previousScoreSnapshot = scoreSnapshot;
    }

    const detailClass = detailPayload.hasDetails ? "timelineRowHasDetails" : "timelineRowNoDetails";
    const scoreChangeBadgeClass = (isScoreChange || isNamedScoreChange) ? "timelineBadgescoreChange" : "";
    const scoreChangeRowClass = (isScoreChange || isNamedScoreChange || eventType.key === "scorechange")
      ? "timelineRowscoreChange"
      : "";
    return `
      <div class="timelineRow ${detailClass} ${scoreChangeRowClass} timelineRow${eventType.key}">
        <span class="timelineTime">${minuteLabel}</span>
        <span class="timelineBadge timelineBadge${eventType.key} ${scoreChangeBadgeClass}">${escapeHtml(eventType.label)}</span>
        <span class="timelineLabel">${escapeHtml(description)}</span>
        ${competitorLabel ? `<span class="timelineMeta">${escapeHtml(competitorLabel)}</span>` : ""}
        ${detailPayload.html}
      </div>
    `;
  });

  if (rows.length === 0) {
    const hasAnyTypes = filterTypeOrder.length > 0;
    const emptyMessage = hasAnyTypes
      ? "No events match the selected filters."
      : "No timeline events for this match.";

    const filtersHtml = renderTimelineFilters(filterTypeOrder, filterTypeLabels);

    return `${filtersHtml}<div class="empty">${emptyMessage}</div>`;
  }

  const filtersHtml = renderTimelineFilters(filterTypeOrder, filterTypeLabels);

  return `${filtersHtml}<div class="timelineList" style="max-height: 600px; overflow-y: auto;">${rows.join("")}</div>`;
}

function renderMatchContextPanel(data) {
  if (!matchContextPanel) return;

  const conditions = data?.sport_event?.sport_event_conditions || {};
  const weather = conditions?.weather || {};
  const overallConditions = String(weather?.overall_conditions || "").trim();
  const pitchConditions = String(weather?.pitch_conditions || "").trim();
  const weatherLabel = [overallConditions, pitchConditions ? `Pitch: ${pitchConditions}` : ""]
    .filter(Boolean)
    .join(" • ") || "Not available";

  const referees = Array.isArray(conditions?.referees) ? conditions.referees : [];
  const refereeLabel = referees.length
    ? referees
        .slice(0, 2)
        .map((referee) => {
          const refName = String(referee?.name || "").trim();
          const refType = String(referee?.type || "").trim().replace(/_/g, " ");
          if (!refName) return "";
          return refType ? `${refName} (${refType})` : refName;
        })
        .filter(Boolean)
        .join(" • ")
    : "Not available";

  matchContextPanel.innerHTML = `
    <div class="matchContextGrid">
      <div class="matchContextItem"><span class="matchContextKey">Weather</span><span class="matchContextValue">${escapeHtml(weatherLabel)}</span></div>
      <div class="matchContextItem"><span class="matchContextKey">Referee</span><span class="matchContextValue">${escapeHtml(refereeLabel)}</span></div>
    </div>
  `;
}

function renderPeriodTotalsPanel(data) {
  if (!periodTotalsPanel) return;

  const periodScores = Array.isArray(data?.sport_event_status?.period_scores)
    ? data.sport_event_status.period_scores
    : [];

  if (!periodScores.length) {
    periodTotalsPanel.innerHTML = `<div class="periodTotalsEmpty">Per-period totals are not available yet.</div>`;
    return;
  }

  const getPeriodLabel = (period) => {
    const typeValue = String(period?.type || "").toLowerCase();
    const numberValue = Number(period?.number);

    if (typeValue.includes("overtime") || typeValue.includes("extra")) return "Overtime";
    if (numberValue === 1) return "First Half";
    if (numberValue === 2) return "Second Half";
    return "Overtime";
  };

  const rows = periodScores.map((period) => {
    const periodLabel = getPeriodLabel(period);
    const homeScore = period?.home_score ?? "—";
    const awayScore = period?.away_score ?? "—";

    return `
      <tr>
        <td>${escapeHtml(periodLabel)}</td>
        <td>${escapeHtml(String(homeScore))}</td>
        <td>${escapeHtml(String(awayScore))}</td>
      </tr>
    `;
  });

  periodTotalsPanel.innerHTML = `
    <div class="periodTotalsWrap">
      <h4>Per-Period Totals</h4>
      <div class="periodTotalsTableWrap">
        <table class="periodTotalsTable">
          <thead>
            <tr>
              <th>Period</th>
              <th>Home</th>
              <th>Away</th>
            </tr>
          </thead>
          <tbody>
            ${rows.join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ==========================================
// ROSTER / LINEUP LOGIC
// ==========================================

async function fetchLineups(forceRefresh = false) {
  if (!currentGame) return;

  lineupContent.innerHTML = `<div class="empty" style="color: var(--muted);">Loading team rosters...</div>`;

  try {
    // We now hit the /rosters endpoint which returns full squad lists
    const refreshParam = forceRefresh ? "&refresh=true" : "";
    const res = await fetch(`/api/rosters?sport_event_id=${currentGame.sport_event_id}${refreshParam}`);
    
    if (!res.ok) {
      // If rosters fail, show message
      lineupContent.innerHTML = `<div class="empty">Rosters unavailable.</div>`;
      return;
    }
    
    const data = await res.json();
    updateRosterPayloadCache(currentGame.sport_event_id, data);
    displayRosters(data);
  } catch (err) {
    console.error(err);
    lineupContent.innerHTML = `<div class="empty">Roster info unavailable.</div>`;
  }
}

function displayRosters(data) {
  // Check if we have home/away data
  if (!data || (!data.home && !data.away)) {
    lineupContent.innerHTML = `<div class="empty">No roster data found.</div>`;
    return;
  }

  // Helper to render the list of players
  const renderPlayerList = (teamProfile) => {
    if (!teamProfile || !teamProfile.players || teamProfile.players.length === 0) {
      return '<div style="padding:8px; color:var(--muted); font-size:12px;">No Data Available.</div>';
    }

    // Sort: Goalkeepers first, then Defenders, Midfielders, Forwards
    const order = { "goalkeeper": 1, "defender": 2, "midfielder": 3, "forward": 4 };
    
    const sortedPlayers = [...teamProfile.players].sort((a, b) => {
      const typeA = (a.type || "").toLowerCase();
      const typeB = (b.type || "").toLowerCase();
      return (order[typeA] || 99) - (order[typeB] || 99);
    });

    return sortedPlayers.map(p => {
      const num = p.jersey_number || "-";
      const name = p.name || "Unknown";
      const type = p.type ? p.type.charAt(0).toUpperCase() + p.type.slice(1) : "Player";
      const country = p.nationality ? `(${p.nationality})` : "";

      return `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 13px;">
          <div style="display:flex; gap:12px; align-items:center;">
            <span style="font-weight:700; color: #4a90e2; width: 24px; text-align:right;">${num}</span>
            <div style="display:flex; flex-direction:column;">
                <span style="color: var(--text); font-weight: 500;">${escapeHtml(name)}</span>
                <span style="color: var(--muted); font-size: 10px;">${escapeHtml(country)}</span>
            </div>
          </div>
          <span style="color: var(--muted); font-size: 11px; font-weight: 600;">${type}</span>
        </div>
      `;
    }).join("");
  };

  // Helper to build a column
  const buildTeamColumn = (profileData, fallbackName) => {
    const teamName = profileData?.competitor?.name || fallbackName;
    const managerName = profileData?.manager?.name || "";

    return `
      <div style="flex: 1; min-width: 300px; background: rgba(255,255,255,0.03); border-radius: 12px; padding: 20px; border: 1px solid var(--line);">
        <h3 style="margin: 0 0 12px 0; color: var(--text); border-bottom: 1px solid var(--line); padding-bottom: 12px;">
          ${escapeHtml(teamName)}
        </h3>
        
        ${managerName ? `<div style="font-size:13px; color:var(--muted); margin-bottom:16px;">Manager: <strong style="color:var(--text);">${managerName}</strong></div>` : ''}

        <h4 style="margin: 0 0 8px 0; color: var(--muted); font-size: 11px; text-transform:uppercase; letter-spacing:1px; font-weight: 700;">Full Squad</h4>
        <div style="max-height: 500px; overflow-y: auto; padding-right: 5px;">
          ${renderPlayerList(profileData)}
        </div>
      </div>
    `;
  };

  const homeCol = buildTeamColumn(data.home, currentGame.home || "Home");
  const awayCol = buildTeamColumn(data.away, currentGame.away || "Away");

  lineupContent.innerHTML = `
    <div style="display: flex; flex-wrap: wrap; gap: 24px;">
      ${homeCol}
      ${awayCol}
    </div>
  `;
}


async function fetchSeasonStandings(forceRefresh = false) {
  if (!currentGame) return;

  // Clear previous content and show loading state if desired
  seasonStandingsContent.innerHTML = `<div class="empty" style="color:#666;">Loading standings...</div>`;

  try {
    const res = await fetch("/api/season-standings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Map the JS properties (home/away) to the Python expected keys (home_team/away_team)
        sport_event_id: currentGame.sport_event_id,
        season_id: currentGame.season_id || "",
        home_team: currentGame.home,
        away_team: currentGame.away,
        refresh: forceRefresh,
      }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    displaySeasonStandings(data);
  } catch (err) {
    console.error("Error fetching season standings:", err);
    seasonStandingsContent.innerHTML = `<div class="empty">Failed to load standings.</div>`;
  }
}

function displaySeasonStandings(data) {
  // Clear previous content
  seasonStandingsContent.innerHTML = "";

  // 1. Extract the actual array of standing tables.
  let tableList = [];
  if (data && data.standings && Array.isArray(data.standings.standings)) {
    tableList = data.standings.standings;
  } else if (data && Array.isArray(data.standings)) {
    tableList = data.standings;
  }

  if (tableList.length === 0) {
    seasonStandingsContent.innerHTML = `<div class="empty">No standings available.</div>`;
    return;
  }

  // 2. Filter ONLY for the 'Total' table
  // If 'total' doesn't exist, we fall back to the first available table to ensure something shows.
  const totalTable = tableList.find(t => t.type === 'total') || tableList[0];
  const tableSet = totalTable; // We only process this one set

  // Determine the title
  const tableType = tableSet.type 
    ? tableSet.type.charAt(0).toUpperCase() + tableSet.type.slice(1) 
    : "League Table";

  // Check if groups exist
  if (!tableSet.groups || !Array.isArray(tableSet.groups)) {
    seasonStandingsContent.innerHTML = `<div class="empty">No standings data found.</div>`;
    return;
  }

  tableSet.groups.forEach((group) => {
    // V4 usually puts rows in 'standings', but sometimes 'competitor_standings'
    const rows = group.standings || group.competitor_standings || [];
    const groupName = group.name || tableType;

    if (rows.length === 0) return;

    // Create a container for this table
    const container = document.createElement("div");
    container.style.marginBottom = "2rem";

    // Header
    const header = document.createElement("h4");
    // If the group name is just "Total", display the Competition name or just "Standings"
    header.textContent = groupName === 'Total' ? 'League Standings' : groupName;
    header.style.margin = "0 0 1rem 0";
    header.style.color = "var(--text)";
    header.style.borderBottom = "1px solid var(--line)";
    header.style.paddingBottom = "0.5rem";
    container.appendChild(header);

    // Scroll wrapper for responsiveness
    const tableWrapper = document.createElement("div");
    tableWrapper.style.overflowX = "auto";
    tableWrapper.style.borderRadius = "12px";
    tableWrapper.style.border = "1px solid var(--line)";
    tableWrapper.style.background = "linear-gradient(135deg, var(--panel), #faf8f5)";

    // Construct Table HTML using your CSS variables
    let tableHtml = `
      <table style="width:100%; border-collapse: collapse; font-size: 14px; min-width: 600px; color: var(--text);">
        <thead>
          <tr style="background: var(--panel2); color: var(--muted); border-bottom: 1px solid var(--line);">
            <th style="padding: 12px 8px; text-align: left; font-weight: 700; width: 40px;">#</th>
            <th style="padding: 12px 8px; text-align: left; font-weight: 700;">Team</th>
            <th style="padding: 12px 8px; text-align: center; font-weight: 700;">P</th>
            <th style="padding: 12px 8px; text-align: center; font-weight: 700;">W</th>
            <th style="padding: 12px 8px; text-align: center; font-weight: 700;">D</th>
            <th style="padding: 12px 8px; text-align: center; font-weight: 700;">L</th>
            <th style="padding: 12px 8px; text-align: center; font-weight: 700;">GF</th>
            <th style="padding: 12px 8px; text-align: center; font-weight: 700;">GA</th>
            <th style="padding: 12px 8px; text-align: center; font-weight: 700;">GD</th>
            <th style="padding: 12px 8px; text-align: center; font-weight: 700;">Pts</th>
            <th style="padding: 12px 8px; text-align: left; font-weight: 700;">Form</th>
          </tr>
        </thead>
        <tbody>
    `;

    rows.forEach((row) => {
      const teamName = row.competitor ? row.competitor.name : (row.team ? row.team.name : "Unknown");
      const formString = row.competitor ? (row.competitor.form || "") : "";
      const rank = row.rank || row.position || "-";
      
      const outcome = row.current_outcome ? row.current_outcome.toLowerCase() : "";
      
      // Default Style (matches your CSS theme)
      let rowBg = "transparent";
      let borderColor = "transparent";
      let textColor = "var(--text)";
      let fontWeight = "400";
      
      // 1. Highlight Logic for Promotion/Relegation (Subtle tints)
      if (outcome.includes("promotion")) {
         rowBg = "rgba(40, 167, 69, 0.1)"; // Subtle Green tint
         borderColor = "#28a745"; // Green indicator
      } else if (outcome.includes("relegation")) {
         rowBg = "rgba(220, 53, 69, 0.1)"; // Subtle Red tint
         borderColor = "#dc3545"; // Red indicator
      }

      // 2. Active Team Logic (Overrides Prom/Rel background for clarity)
      const isHome = currentGame && currentGame.home === teamName;
      const isAway = currentGame && currentGame.away === teamName;
      
      if (isHome || isAway) {
          // Stronger highlight for the active teams
         rowBg = "rgba(74, 85, 104, 0.12)";
          fontWeight = "700";
          // We keep the border color if it exists (to show they are also in promotion spot), 
          // otherwise default to blue border
          if (borderColor === "transparent") {
           borderColor = "#4a5568";
          }
      }

      // Generate Form Badges (W/D/L)
      let formBadges = "";
      if (formString) {
        formBadges = formString.split("").map(char => {
          let color = "#6c757d"; // Default Gray (Draw)
          if (char === "W") color = "#28a745"; // Green
          if (char === "L") color = "#dc3545"; // Red
          return `<span style="display:inline-block; width:18px; height:18px; line-height:18px; text-align:center; background-color:${color}; color:white; font-size:10px; border-radius:3px; margin-right:2px; font-weight:600;">${char}</span>`;
        }).join("");
      }

      tableHtml += `
        <tr style="background-color: ${rowBg}; border-bottom: 1px solid var(--line); color: ${textColor}; font-weight: ${fontWeight};">
          <td style="padding: 10px 8px; text-align: left; border-left: 4px solid ${borderColor};">${rank}</td>
          <td style="padding: 10px 8px; text-align: left;">${escapeHtml(teamName)}</td>
          <td style="padding: 10px 8px; text-align: center;">${row.played || 0}</td>
          <td style="padding: 10px 8px; text-align: center;">${row.win || 0}</td>
          <td style="padding: 10px 8px; text-align: center;">${row.draw || 0}</td>
          <td style="padding: 10px 8px; text-align: center;">${row.loss || 0}</td>
          <td style="padding: 10px 8px; text-align: center;">${row.goals_for || 0}</td>
          <td style="padding: 10px 8px; text-align: center;">${row.goals_against || 0}</td>
          <td style="padding: 10px 8px; text-align: center;">${row.goals_diff > 0 ? "+" + row.goals_diff : (row.goals_diff || 0)}</td>
          <td style="padding: 10px 8px; text-align: center; font-weight: 700;">${row.points || 0}</td>
          <td style="padding: 10px 8px; text-align: left;">${formBadges}</td>
        </tr>
      `;
    });

    tableHtml += `</tbody></table>`;
    tableWrapper.innerHTML = tableHtml;
    
    container.appendChild(tableWrapper);
    seasonStandingsContent.appendChild(container);
  });

  if (seasonStandingsContent.innerHTML === "") {
    seasonStandingsContent.innerHTML = `<div class="empty">No standings rows found.</div>`;
  }
}

async function checkAuthStatus() {
  try {
    const res = await fetch("/api/user");
    const data = await res.json();
    if (data.authenticated && data.user) {
      currentUser = data.user;
      if (loginBtn) {
        loginBtn.textContent = `Logout (${data.user.name})`;
        loginBtn.onclick = () => { window.location.href = "/logout"; };
      }
    } else {
      currentUser = null;
      if (loginBtn) {
        loginBtn.textContent = "Log In with Google";
        loginBtn.onclick = () => { window.location.href = "/login"; };
      }
    }
  } catch (err) {
    currentUser = null;
    if (loginBtn) {
      loginBtn.textContent = "Log In with Google";
      loginBtn.onclick = () => { window.location.href = "/login"; };
    }
  }

  updateChatAccessUI();
}

function renderWelcomeChat() {
  chatbotContent.innerHTML = `
    <div class="chatbotWelcome">
      <p>Ask me anything about this game!</p>
    </div>
  `;
}

function renderChatMessages(messages) {
  chatbotContent.innerHTML = "";
  if (!Array.isArray(messages) || messages.length === 0) {
    renderWelcomeChat();
    return;
  }

  for (const message of messages) {
    addChatMessage(message.content, message.role === "user");
  }
}

async function loadChatMessagesForGame(gameId) {
  if (!gameId) {
    if (currentUser) {
      renderWelcomeChat();
    } else {
      renderLoginRequiredChat();
    }
    return;
  }
  if (!currentUser) {
    await checkAuthStatus();
    if (!currentUser) {
      renderLoginRequiredChat();
      return;
    }
  }

  try {
    const response = await fetch(`/api/chat-history/${encodeURIComponent(gameId)}`);
    if (!response.ok) {
      renderWelcomeChat();
      return;
    }

    const data = await response.json();
    renderChatMessages(Array.isArray(data.messages) ? data.messages : []);
  } catch {
    renderWelcomeChat();
  }
}

async function saveChatMessageToHistory(role, content) {
  if (!currentUser) return;

  const sportEventId = getGameIdFromUrl();
  if (!sportEventId || !content) return;

  try {
    await fetch("/api/chat-history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sport_event_id: sportEventId,
        role,
        content,
        home_team: currentGame?.home || "",
        away_team: currentGame?.away || "",
        start_time: currentGame?.start_time || "",
      }),
    });
  } catch {
    // intentionally ignore persistence errors for chat UX continuity
  }
}

function addChatMessage(text, isUser) {
  const messageEl = document.createElement("div");
  messageEl.className = `chatMessage ${isUser ? "userMessage" : "botMessage"}`;
  if (isUser) {
    messageEl.textContent = text;
  } else {
    messageEl.innerHTML = renderMarkdown(text);
  }
  
  // Remove welcome message if it exists
  const welcome = chatbotContent.querySelector(".chatbotWelcome");
  if (welcome) {
    welcome.remove();
  }
  
  chatbotContent.appendChild(messageEl);
  chatbotContent.scrollTop = chatbotContent.scrollHeight;
}

function addThinkingIndicator() {
  const thinkingEl = document.createElement("div");
  thinkingEl.className = "chatMessage botMessage thinkingMessage";
  thinkingEl.innerHTML = `
    <div class="thinkingDots" aria-label="Assistant is thinking">
      <span></span><span></span><span></span>
    </div>
  `;

  const welcome = chatbotContent.querySelector(".chatbotWelcome");
  if (welcome) {
    welcome.remove();
  }

  chatbotContent.appendChild(thinkingEl);
  chatbotContent.scrollTop = chatbotContent.scrollHeight;
  return thinkingEl;
}

function removeThinkingIndicator(thinkingEl) {
  if (!thinkingEl) return;
  if (thinkingEl.parentElement === chatbotContent) {
    thinkingEl.remove();
  }
}

async function typeBotMessage(text) {
  const fullText = String(text || "");
  const messageEl = document.createElement("div");
  messageEl.className = "chatMessage botMessage";

  chatbotContent.appendChild(messageEl);

  const charDelayMs = 14;
  let composed = "";
  for (let index = 0; index < fullText.length; index += 1) {
    composed += fullText[index];
    messageEl.innerHTML = renderMarkdown(composed);
    chatbotContent.scrollTop = chatbotContent.scrollHeight;
    await new Promise((resolve) => setTimeout(resolve, charDelayMs));
  }

  messageEl.innerHTML = renderMarkdown(fullText);
  chatbotContent.scrollTop = chatbotContent.scrollHeight;
}

function resolveCompetitorIds(game) {
  const directHome = String(game?.competitor_id || "").trim();
  const directAway = String(game?.competitor2_id || "").trim();

  if (directHome && directAway) {
    return { competitorId: directHome, competitor2Id: directAway };
  }

  const competitors = Array.isArray(game?.competitors) ? game.competitors : [];
  const homeFromQualifier = String(
    competitors.find((c) => c?.qualifier === "home")?.id || ""
  ).trim();
  const awayFromQualifier = String(
    competitors.find((c) => c?.qualifier === "away")?.id || ""
  ).trim();

  const orderedIds = competitors.map((c) => c?.id).filter(Boolean).map((id) => String(id).trim());

  const competitorId = directHome || homeFromQualifier || orderedIds[0] || "";
  const competitor2Id = directAway || awayFromQualifier || orderedIds[1] || "";

  return { competitorId, competitor2Id };
}

async function resolveCompetitorIdsFromBackend(game) {
  const sportEventId = String(game?.sport_event_id || getGameIdFromUrl() || "").trim();
  const competitionId = String(game?.competition_id || "").trim();
  const homeTeam = String(game?.home || "").trim();
  const awayTeam = String(game?.away || "").trim();

  if (!sportEventId && (!competitionId || !homeTeam || !awayTeam)) {
    return { competitorId: "", competitor2Id: "" };
  }

  try {
    const response = await fetch("/api/resolve-competitor-ids", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sport_event_id: sportEventId,
        competition_id: competitionId,
        home_team: homeTeam,
        away_team: awayTeam,
      }),
    });

    if (!response.ok) {
      return { competitorId: "", competitor2Id: "" };
    }

    const data = await response.json();
    return {
      competitorId: String(data?.competitor_id || "").trim(),
      competitor2Id: String(data?.competitor2_id || "").trim(),
    };
  } catch {
    return { competitorId: "", competitor2Id: "" };
  }
}

function extractLineupCompetitors(lineupData) {
  if (!lineupData) return [];
  if (Array.isArray(lineupData.lineups)) return lineupData.lineups;
  if (Array.isArray(lineupData.lineups?.competitors)) return lineupData.lineups.competitors;
  if (Array.isArray(lineupData.competitors)) return lineupData.competitors;
  return [];
}

function mergeTeamPlayers(teamData) {
  const merged = [];
  const seen = new Set();

  const append = (players, starterDefault = null) => {
    if (!Array.isArray(players)) return;
    for (const player of players) {
      if (!player) continue;
      const playerId = String(player.id || player.player_id || player.player?.id || "").trim();
      const fallbackKey = `${player.name || ""}-${player.jersey_number || ""}-${merged.length}`;
      const dedupeKey = playerId || fallbackKey;
      if (seen.has(dedupeKey)) continue;
      const next = { ...player };
      if (starterDefault !== null && next.starter === undefined) {
        next.starter = starterDefault;
      }
      merged.push(next);
      seen.add(dedupeKey);
    }
  };

  append(teamData?.starting_lineup, true);
  append(teamData?.substitutes, false);
  append(teamData?.players, null);

  return merged;
}

function buildLineupPayload(lineupData) {
  const competitors = extractLineupCompetitors(lineupData);
  const players = [];
  const seenPlayerIds = new Set();

  for (const teamData of competitors) {
    const teamPlayers = mergeTeamPlayers(teamData);
    for (const player of teamPlayers) {
      const playerId = String(player?.id || player?.player_id || player?.player?.id || "").trim();
      const playerName = String(player?.name || player?.player?.name || "").trim();
      if (!playerId || !playerName || seenPlayerIds.has(playerId)) continue;
      players.push({
        name: playerName,
        player_id: playerId,
      });
      seenPlayerIds.add(playerId);
    }
  }

  return {
    players,
  };
}

function buildRostersPayload(rostersData) {
  const players = [];
  const seenPlayerIds = new Set();

  const appendRoster = (teamProfile) => {
    const teamPlayers = Array.isArray(teamProfile?.players) ? teamProfile.players : [];
    for (const player of teamPlayers) {
      const playerId = String(player?.id || player?.player_id || player?.player?.id || "").trim();
      const playerName = String(player?.name || player?.player?.name || "").trim();
      if (!playerId || !playerName || seenPlayerIds.has(playerId)) continue;
      players.push({
        name: playerName,
        player_id: playerId,
      });
      seenPlayerIds.add(playerId);
    }
  };

  appendRoster(rostersData?.home);
  appendRoster(rostersData?.away);

  return {
    players,
  };
}

function updateLineupPayloadCache(sportEventId, lineupData) {
  const sportEventIdString = String(sportEventId || "").trim();
  const payload = buildLineupPayload(lineupData);
  cachedLineupEventId = sportEventIdString;
  cachedPlayersPayload = payload.players;
  return payload;
}

function updateRosterPayloadCache(sportEventId, rostersData) {
  const sportEventIdString = String(sportEventId || "").trim();
  const payload = buildRostersPayload(rostersData);
  cachedLineupEventId = sportEventIdString;
  cachedPlayersPayload = payload.players;
  return payload;
}

async function ensureLineupPayloadData(sportEventId) {
  const sportEventIdString = String(sportEventId || "").trim();
  if (!sportEventIdString) {
    return { players: [] };
  }

  if (cachedLineupEventId === sportEventIdString && Array.isArray(cachedPlayersPayload) && cachedPlayersPayload.length > 0) {
    return {
      players: cachedPlayersPayload || [],
    };
  }

  try {
    const rosterResponse = await fetch(`/api/rosters?sport_event_id=${encodeURIComponent(sportEventIdString)}`);
    if (rosterResponse.ok) {
      const rostersData = await rosterResponse.json();
      const rosterPayload = updateRosterPayloadCache(sportEventIdString, rostersData);
      if (Array.isArray(rosterPayload.players) && rosterPayload.players.length > 0) {
        return rosterPayload;
      }
    }

    const lineupResponse = await fetch(`/api/starting-lineups?sport_event_id=${encodeURIComponent(sportEventIdString)}`);
    if (!lineupResponse.ok) {
      return { players: [] };
    }
    const lineupData = await lineupResponse.json();
    return updateLineupPayloadCache(sportEventIdString, lineupData?.lineups || null);
  } catch {
    return { players: [] };
  }
}

function sanitizePlayersForPayload(players) {
  if (!Array.isArray(players)) return [];
  return players
    .map((player) => ({
      name: String(player?.name || "").trim(),
      player_id: String(player?.player_id || "").trim(),
    }))
    .filter((player) => player.name && player.player_id);
}

async function fetchStartingLineups(forceRefresh = false) {
  if (!currentGame) return;

  startingLineupContent.innerHTML = `<div class="empty" style="color: var(--muted);">Checking the lineups...</div>`;

  try {
    // This assumes you added the Python route /api/starting-lineups provided previously
    const refreshParam = forceRefresh ? "&refresh=true" : "";
    const res = await fetch(`/api/starting-lineups?sport_event_id=${currentGame.sport_event_id}${refreshParam}`);
    
    if (res.status === 404) {
      startingLineupContent.innerHTML = `<div class="empty">Starting lineups not posted yet.</div>`;
      return;
    }

    if (!res.ok) throw new Error("Failed to fetch");

    const data = await res.json();
    updateLineupPayloadCache(currentGame.sport_event_id, data?.lineups || null);
    displayStartingLineups(data.lineups);
  } catch (err) {
    console.error(err);
    startingLineupContent.innerHTML = `<div class="empty">Starting lineups not posted yet.</div>`;
  }
}

function displayStartingLineups(lineupData) {
  console.log("[DEBUG] Raw Lineup Data:", lineupData);

  // 1. Check if the main data object exists
  if (!lineupData) {
    startingLineupContent.innerHTML = `<div class="empty">No lineup data received.</div>`;
    return;
  }

  // 2. Check coverage
  let coverage = true;
  if (lineupData.sport_event?.coverage?.sport_event_properties?.lineups === false) {
    coverage = false;
  }

  // 3. Check for the competitors array (Not 'lineups', but 'competitors' inside 'lineups' object)
  // Your JSON structure is: { lineups: { competitors: [...] } }
  // OR sometimes just { lineups: [...] } depending on the API version/tier
  
  let competitors = [];
  if (lineupData.lineups && Array.isArray(lineupData.lineups)) {
     // Case A: direct array
     competitors = lineupData.lineups;
  } else if (lineupData.lineups && lineupData.lineups.competitors) {
     // Case B: nested object (matches your JSON example)
     competitors = lineupData.lineups.competitors;
  }

  if (!competitors || competitors.length === 0) {
    if (!coverage) {
      startingLineupContent.innerHTML = `<div class="empty">Starting lineups were not covered for this match.</div>`;
    } else {
      startingLineupContent.innerHTML = `<div class="empty">Starting lineups not available yet.</div>`;
    }
    return;
  }

  // 4. Data exists - Parse Home and Away
  const home = competitors.find(c => c.qualifier === 'home') || competitors[0];
  const away = competitors.find(c => c.qualifier === 'away') || competitors[1];

  // Helper function to generate the HTML for one team
  const renderTeamCard = (teamData, teamName) => {
    if (!teamData) return `<div class="empty">No data for ${escapeHtml(teamName)}</div>`;

    // ---------------------------------------------------------
    // NEW PARSING LOGIC HERE
    // ---------------------------------------------------------
    
    let starters = [];
    let subs = [];

    // Check if the API gave us pre-sorted arrays (some versions do)
    if (teamData.starting_lineup) {
        starters = teamData.starting_lineup;
        subs = teamData.substitutes || [];
    } 
    // Otherwise, filter the main 'players' list (matches your JSON example)
    else if (teamData.players) {
        starters = teamData.players.filter(p => p.starter === true);
        subs = teamData.players.filter(p => !p.starter);
    }

    // Sort by jersey number or order
    const sortFn = (a, b) => (parseInt(a.jersey_number)||0) - (parseInt(b.jersey_number)||0);
    starters.sort(sortFn);
    subs.sort(sortFn);

    // Render Rows Function
    const renderRows = (players) => {
      if (players.length === 0) return '<div style="padding:8px; color:var(--muted); font-size:12px;">No players listed</div>';
      
      return players.map(p => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--line); font-size:13px;">
          <div style="display:flex; align-items:center; gap:10px;">
            <span style="font-weight:700; color:var(--accent); display:inline-block; width:20px; text-align:right;">${p.jersey_number || '-'}</span>
            <span style="color:var(--text); font-weight:500;">${escapeHtml(p.name)}</span>
          </div>
          <span style="font-size:11px; color:var(--muted); background:var(--panel2); padding:2px 6px; border-radius:4px;">
            ${p.type ? p.type.charAt(0).toUpperCase() : '?'}
          </span>
        </div>
      `).join('');
    };

    return `
      <div style="flex:1; min-width:300px; background:var(--panel); padding:20px; border-radius:12px; border:1px solid var(--line); box-shadow:0 2px 8px rgba(0,0,0,0.04);">
        
        <!-- Header -->
        <div style="margin-bottom:16px; border-bottom:2px solid var(--line); padding-bottom:12px;">
          <h3 style="margin:0 0 4px 0; color:var(--text); font-size:16px;">${escapeHtml(teamName)}</h3>
          <div style="display:flex; gap:12px; font-size:12px; color:var(--muted);">
             ${teamData.manager ? `<span>Mgr: <strong>${escapeHtml(teamData.manager.name)}</strong></span>` : ''}
             ${teamData.formation ? `<span>Formation: <strong>${escapeHtml(teamData.formation.type || teamData.formation)}</strong></span>` : ''}
          </div>
        </div>

        <!-- Starting XI Section -->
        <h4 style="margin:0 0 8px 0; font-size:11px; text-transform:uppercase; letter-spacing:1px; color:var(--text); font-weight:700;">Starters</h4>
        <div style="margin-bottom:20px;">
          ${renderRows(starters)}
        </div>

        <!-- Substitutes Section -->
        <h4 style="margin:0 0 8px 0; font-size:11px; text-transform:uppercase; letter-spacing:1px; color:var(--muted); font-weight:700;">Substitutes</h4>
        <div>
          ${renderRows(subs)}
        </div>
      </div>
    `;
  };

  startingLineupContent.innerHTML = `
    <div style="display:flex; gap:24px; flex-wrap:wrap;">
      ${renderTeamCard(home, currentGame.home || "Home")}
      ${renderTeamCard(away, currentGame.away || "Away")}
    </div>
  `;
}

async function sendChatMessage() {
  const message = chatInput.value.trim();
  if (!message) return;

  if (!currentUser) {
    await checkAuthStatus();
    if (!currentUser) {
      renderLoginRequiredChat();
      return;
    }
  }
  
  // Initialize session if needed
  if (!sessionId) {
    const gameId = getGameIdFromUrl();
    initializeSession(gameId);
  }
  
  // Add user message to chat
  addChatMessage(message, true);
  await saveChatMessageToHistory("user", message);
  chatInput.value = "";
  if (sendBtn) sendBtn.disabled = true;
  if (chatInput) chatInput.disabled = true;

  const thinkingEl = addThinkingIndicator();
  
  try {
    // Send to n8n webhook
    const gameId = getGameIdFromUrl();
    const sportEventIdString = String(gameId || "");
    const lineupPayload = await ensureLineupPayloadData(sportEventIdString);
    let { competitorId, competitor2Id } = resolveCompetitorIds(currentGame || {});
    if (!competitorId || !competitor2Id) {
      const resolved = await resolveCompetitorIdsFromBackend(currentGame || {});
      competitorId = competitorId || resolved.competitorId;
      competitor2Id = competitor2Id || resolved.competitor2Id;
    }
    const competitorIdString = String(competitorId || "");
    const competitor2IdString = String(competitor2Id || "");
    const homeTeamName = String(currentGame?.home || "").trim();
    const awayTeamName = String(currentGame?.away || "").trim();
    console.log("[DEBUG] Game ID from URL:", gameId);
    console.log("[DEBUG] Current game:", currentGame);
    const sanitizedPlayers = sanitizePlayersForPayload(lineupPayload.players);
    const payload = {
      sport_event_id: sportEventIdString,
      competitor_id: competitorIdString,
      competitor2_id: competitor2IdString,
      teams: {
        home: {
          team_id: competitorIdString,
          team_name: homeTeamName,
        },
        away: {
          team_id: competitor2IdString,
          team_name: awayTeamName,
        },
      },
      chatInput: message,
      sessionId: sessionId,
      players: sanitizedPlayers
    };
    console.log("[DEBUG] Payload being sent:", payload);
    
    const response = await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const contentType = response.headers.get("content-type") || "";
    const rawBody = await response.text();
    let data;

    if (!rawBody.trim()) {
      data = { response: "No response received" };
    } else if (contentType.includes("application/json")) {
      try {
        data = JSON.parse(rawBody);
      } catch {
        data = { response: rawBody };
      }
    } else {
      data = { response: rawBody };
    }
    
    const botReply = data.output || data.response || data.message || "No response received";
    removeThinkingIndicator(thinkingEl);
    await typeBotMessage(botReply);
    await saveChatMessageToHistory("assistant", botReply);
  } catch (err) {
    removeThinkingIndicator(thinkingEl);
    await typeBotMessage(`Error: ${err.message}`);
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    if (chatInput) {
      chatInput.disabled = false;
      chatInput.focus();
    }
  }
}

backBtn.addEventListener("click", () => {
  if (window.history.length > 1 && document.referrer) {
    window.history.back();
    return;
  }
  window.location.href = "/";
});

refreshBtn.addEventListener("click", async () => {
  await loadGameDetail(true);
  await fetchStartingLineups(true);
});

if (sendBtn) {
  sendBtn.addEventListener("click", sendChatMessage);
}

if (chatInput) {

    updateChatAccessUI();
  chatInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      sendChatMessage();
    }
  });
}

async function initializeGameDetailPage() {
  await checkAuthStatus();
  await loadGameDetail();
  const gameId = getGameIdFromUrl();
  initializeSession(gameId);
}

initializeGameDetailPage();
