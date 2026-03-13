const backBtn = document.getElementById("backBtn");
const statusPill = document.getElementById("statusPill");
const favoriteLeagueSelect = document.getElementById("favoriteLeagueSelect");
const saveBtn = document.getElementById("saveBtn");

let competitions = [];
let currentUser = null;
let isBusy = false;

function setStatus(text, tone = "neutral") {
  if (!statusPill) return;
  statusPill.textContent = text;
  statusPill.classList.remove("statusOk", "statusWarn", "statusError");
  if (tone === "ok") statusPill.classList.add("statusOk");
  if (tone === "warn") statusPill.classList.add("statusWarn");
  if (tone === "error") statusPill.classList.add("statusError");
}

function updateActionButtons() {
  const isAuthenticated = Boolean(currentUser);
  const selectedLeagueId = String(favoriteLeagueSelect?.value || "").trim();

  if (saveBtn) {
    saveBtn.disabled = isBusy || !isAuthenticated || !selectedLeagueId;
  }
}

function setBusyState(nextValue) {
  isBusy = Boolean(nextValue);
  updateActionButtons();
}

function fillLeagueSelect(items) {
  favoriteLeagueSelect.innerHTML = `<option value="">Select a league…</option>`;
  for (const c of items) {
    const opt = document.createElement("option");
    opt.value = String(c.id || "");
    opt.textContent = String(c.name || c.id || "Unknown League");
    favoriteLeagueSelect.appendChild(opt);
  }
}

async function loadCompetitions() {
  const res = await fetch(`/api/competitions?ts=${Date.now()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  competitions = Array.isArray(data.competitions) ? data.competitions : [];
  return competitions;
}

async function checkAuthStatus() {
  try {
    const response = await fetch(`/api/user?ts=${Date.now()}`);
    if (!response.ok) {
      currentUser = null;
      return;
    }

    const data = await response.json();
    currentUser = data?.authenticated ? data.user : null;
  } catch {
    currentUser = null;
  }
}

async function loadFavoriteLeaguePreference() {
  if (!currentUser) return "";

  try {
    const response = await fetch(`/api/user-favorite-league?ts=${Date.now()}`);
    if (!response.ok) return "";
    const data = await response.json();
    return String(data?.favorite_league_id || "").trim();
  } catch {
    return "";
  }
}

async function initializeSettings() {
  setStatus("Loading...", "warn");
  try {
    await loadCompetitions();
    fillLeagueSelect(competitions);

    await checkAuthStatus();
    if (!currentUser) {
      favoriteLeagueSelect.disabled = true;
      updateActionButtons();
      setStatus("Log in to save", "warn");
      return;
    }

    favoriteLeagueSelect.disabled = false;

    const favoriteId = await loadFavoriteLeaguePreference();
    if (favoriteId) {
      favoriteLeagueSelect.value = favoriteId;
      setStatus("Saved", "ok");
    } else {
      favoriteLeagueSelect.value = "";
      setStatus("No favorite saved", "warn");
    }

    updateActionButtons();
  } catch (err) {
    console.error(err);
    setStatus("Error", "error");
  }
}

backBtn?.addEventListener("click", () => {
  if (window.history.length > 1) window.history.back();
  else window.location.href = "/";
});

favoriteLeagueSelect?.addEventListener("change", async () => {
  const selectedLeagueId = String(favoriteLeagueSelect.value || "").trim();
  if (!selectedLeagueId) {
    setStatus("No favorite saved", "warn");
  } else {
    setStatus("Unsaved changes", "warn");
  }
  updateActionButtons();
});

saveBtn?.addEventListener("click", async () => {
  if (!currentUser) {
    setStatus("Log in first", "warn");
    return;
  }

  const leagueId = String(favoriteLeagueSelect.value || "");

  if (!leagueId) {
    setStatus("Pick a league", "warn");
    return;
  }

  setBusyState(true);
  try {
    const response = await fetch("/api/user-favorite-league", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ competition_id: leagueId }),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    setStatus("Saved", "ok");
  } catch {
    setStatus("Error", "error");
  } finally {
    setBusyState(false);
  }
});

initializeSettings();

