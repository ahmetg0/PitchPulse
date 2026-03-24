import requests
import os
from datetime import datetime, timezone
from dotenv import load_dotenv
from schedule_cache import (
    upsert_competitors_for_game,
    get_competitor_id,
    upsert_sport_event_competitors,
)

load_dotenv()

SPORTRADAR_API_KEY = os.getenv("SPORTRADAR_API_KEY")
SPORTRADAR_BASE_URL = "https://api.sportradar.com/soccer/trial/v4"
SPORTRADAR_EXTENDED_BASE_URL = "https://api.sportradar.com/soccer-extended/trial/v4/en"


class SportradarAPIError(Exception):
    def __init__(self, message, status_code=None, details=None):
        super().__init__(message)
        self.status_code = status_code
        self.details = details


def _get_json(url, timeout=15):
    if not SPORTRADAR_API_KEY:
        raise SportradarAPIError("Missing SPORTRADAR_API_KEY", status_code=500)

    try:
        response = requests.get(
            url,
            headers={
                "accept": "application/json",
                "x-api-key": SPORTRADAR_API_KEY,
            },
            timeout=timeout,
        )
        response.raise_for_status()
        return response.json()
    except requests.exceptions.HTTPError as error:
        response = error.response
        status_code = response.status_code if response is not None else None
        details = response.text if response is not None else str(error)
        raise SportradarAPIError(
            "Sportradar request failed",
            status_code=status_code,
            details=details,
        ) from error
    except requests.exceptions.RequestException as error:
        raise SportradarAPIError(
            "Sportradar request failed",
            status_code=502,
            details=str(error),
        ) from error


def fetch_competitions():
    """
    Fetch competitions and return [{id, name}].
    Deduplicates by name to avoid showing the same league multiple times.
    Endpoint:
    https://api.sportradar.com/soccer-extended/trial/v4/en/competitions.json
    """
    url = f"{SPORTRADAR_EXTENDED_BASE_URL}/competitions.json"
    data = _get_json(url)

    competitions = []
    seen_names = set()
    for item in data.get("competitions", []):
        competition_id = item.get("id")
        competition_name = item.get("name")
        if competition_id and competition_name:
            # Skip if we've already seen this competition name
            if competition_name.lower() not in seen_names:
                competitions.append({
                    "id": competition_id,
                    "name": competition_name,
                })
                seen_names.add(competition_name.lower())

    competitions.sort(key=lambda item: item["name"].lower())
    return competitions


def fetch_seasons_for_competition(competition_id):
    """
    Fetch seasons for one competition.
    Endpoint:
    https://api.sportradar.com/soccer-extended/trial/v4/en/competitions/{competition_id}/seasons.json
    """
    if not competition_id:
        return []

    url = f"{SPORTRADAR_EXTENDED_BASE_URL}/competitions/{competition_id}/seasons.json"
    data = _get_json(url)

    seasons = []
    for season in data.get("seasons", []):
        season_id = season.get("id")
        season_name = season.get("name")
        if season_id and season_name:
            seasons.append({
                "id": season_id,
                "name": season_name,
                "start_date": season.get("start_date"),
                "end_date": season.get("end_date"),
                "year": season.get("year"),
            })

    def season_sort_key(item):
        return (
            item.get("start_date") or "",
            item.get("year") or "",
            item.get("name") or "",
        )

    seasons.sort(key=season_sort_key, reverse=True)
    return seasons


def fetch_seasons_for_competitions(competitions):
    """
    Take [{id, name}] and fetch season ids for each competition.
    Returns:
    [
      {"competition_id": "...", "competition_name": "...", "seasons": [{"id": "...", "name": "..."}]}
    ]
    """
    results = []

    for competition in competitions:
        competition_id = competition.get("id")
        if not competition_id:
            continue

        seasons = fetch_seasons_for_competition(competition_id)
        results.append({
            "competition_id": competition_id,
            "competition_name": competition.get("name", "Unknown Competition"),
            "seasons": seasons,
        })

    return results


def fetch_live_season_for_competition(competition_id):
    """
    Return the first live season id found for a competition.
    If no live game is found for that competition, returns None.
    """
    if not competition_id:
        return None

    url = f"{SPORTRADAR_BASE_URL}/en/schedules/live/summaries.json"
    data = _get_json(url)

    for item in data.get("summaries", []):
        sport_event = item.get("sport_event", {})
        sport_event_context = sport_event.get("sport_event_context", {})
        competition = sport_event_context.get("competition", {})
        season = sport_event_context.get("season", {})

        if competition.get("id") == competition_id and season.get("id"):
            return season.get("id")

    return None


def _classify_game_bucket(status, start_time):
    status_value = (status or "").lower()
    if status_value in {
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
    }:
        return "current"
    if status_value in {"closed", "ended", "finished", "complete", "abandoned", "cancelled"}:
        return "past"
    if status_value in {"not_started", "scheduled", "created", "postponed"}:
        return "future"

    if not start_time:
        return "future"

    try:
        parsed_start_time = datetime.fromisoformat(start_time.replace("Z", "+00:00"))
        return "past" if parsed_start_time < datetime.now(timezone.utc) else "future"
    except Exception:
        return "future"


def _extract_competitor_ids(competitors):
    if not isinstance(competitors, list) or not competitors:
        return None, None

    home_id = next((c.get("id") for c in competitors if c.get("qualifier") == "home" and c.get("id")), None)
    away_id = next((c.get("id") for c in competitors if c.get("qualifier") == "away" and c.get("id")), None)

    if home_id and away_id:
        return home_id, away_id

    ids_by_order = [c.get("id") for c in competitors if c.get("id")]
    if not home_id and len(ids_by_order) >= 1:
        home_id = ids_by_order[0]
    if not away_id and len(ids_by_order) >= 2:
        away_id = ids_by_order[1]

    return home_id, away_id


def _fetch_lineup_competitor_ids(sport_event_id):
    if not sport_event_id:
        return None, None

    url = f"{SPORTRADAR_EXTENDED_BASE_URL}/sport_events/{sport_event_id}/lineups.json"
    try:
        data = _get_json(url, timeout=20)
    except SportradarAPIError:
        return None, None

    lineups_competitors = ((data.get("lineups") or {}).get("competitors") or [])
    home_id, away_id = _extract_competitor_ids(lineups_competitors)
    if home_id and away_id:
        return home_id, away_id

    sport_event_competitors = ((data.get("sport_event") or {}).get("competitors") or [])
    fallback_home_id, fallback_away_id = _extract_competitor_ids(sport_event_competitors)
    return home_id or fallback_home_id, away_id or fallback_away_id


def fetch_competitor_ids_for_sport_event(sport_event_id):
    home_id, away_id = _fetch_lineup_competitor_ids(sport_event_id)
    return str(home_id or "").strip(), str(away_id or "").strip()


def fetch_schedule_for_season(season_id):
    """
    Fetch schedule for one season and normalize games.
    Endpoint:
    https://api.sportradar.com/soccer-extended/trial/v4/en/seasons/{season_id}/schedules.json
    """
    if not season_id:
        return []

    url = f"{SPORTRADAR_EXTENDED_BASE_URL}/seasons/{season_id}/schedules.json"
    data = _get_json(url, timeout=25)

    games = []
    for item in data.get("schedules", []):
        sport_event = item.get("sport_event", {})
        sport_event_status = item.get("sport_event_status", {})
        sport_event_context = sport_event.get("sport_event_context", {})

        competition = sport_event_context.get("competition", {})
        category = sport_event_context.get("category", {})

        sport_event_id = sport_event.get("id")
        competitors = sport_event.get("competitors", [])
        home_team = next((c.get("name") for c in competitors if c.get("qualifier") == "home"), "Home")
        away_team = next((c.get("name") for c in competitors if c.get("qualifier") == "away"), "Away")
        home_competitor_id, away_competitor_id = _extract_competitor_ids(competitors)

        competition_id = competition.get("id")

        if (not home_competitor_id or not away_competitor_id) and sport_event_id:
            lineup_home_id, lineup_away_id = _fetch_lineup_competitor_ids(sport_event_id)
            home_competitor_id = home_competitor_id or lineup_home_id
            away_competitor_id = away_competitor_id or lineup_away_id

        if competition_id:
            home_competitor_id = home_competitor_id or get_competitor_id(competition_id, home_team)
            away_competitor_id = away_competitor_id or get_competitor_id(competition_id, away_team)

            upsert_competitors_for_game(
                competition_id=competition_id,
                home_team=home_team,
                home_competitor_id=home_competitor_id,
                away_team=away_team,
                away_competitor_id=away_competitor_id,
            )

        match_status = (sport_event_status.get("match_status") or sport_event_status.get("status") or "NOT_STARTED").upper()
        start_time = sport_event.get("start_time")

        game = {
            "sport_event_id": sport_event_id,
            "season_id": season_id,
            "league": competition.get("name", "Unknown Competition"),
            "competition_id": competition_id,
            "country": category.get("name", "World"),
            "home": home_team,
            "away": away_team,
            "competitor_id": home_competitor_id,
            "competitor2_id": away_competitor_id,
            "score_home": sport_event_status.get("home_score", 0),
            "score_away": sport_event_status.get("away_score", 0),
            "status": match_status,
            "minute": (sport_event_status.get("clock") or {}).get("played", "N/A"),
            "venue": (sport_event.get("venue") or {}).get("name", "TBA"),
            "start_time": start_time,
            "bucket": _classify_game_bucket(match_status, start_time),
        }

        upsert_sport_event_competitors(
            sport_event_id=sport_event_id,
            competition_id=competition_id,
            home_team=home_team,
            away_team=away_team,
            competitor_id=home_competitor_id,
            competitor2_id=away_competitor_id,
        )

        games.append(game)

    games.sort(key=lambda item: item.get("start_time") or "")
    return games


def fetch_all_live_games():
    """
    Fetch ALL live soccer games globally from SportRadar v4 API.
    Endpoint: /schedules/live/summaries.json
    """
    if not SPORTRADAR_API_KEY:
        print("Error: Missing SPORTRADAR_API_KEY")
        return []

    try:
        # Global Live Endpoint
        url = f"{SPORTRADAR_BASE_URL}/en/schedules/live/summaries.json"

        headers = {
            "accept": "application/json",
            "x-api-key": SPORTRADAR_API_KEY,
        }

        print(f"Fetching Global Live Data from: {url}")
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()

        data = response.json()
        all_live_games = data.get("summaries", [])
        
        games = []
        print(f"Found {len(all_live_games)} live games globally.")

        for item in all_live_games:
            sport_event = item.get("sport_event", {})
            sport_event_context = sport_event.get("sport_event_context", {})
            competition = sport_event_context.get("competition", {})
            status_obj = item.get("sport_event_status", {})
            
            # Competitors
            competitors = sport_event.get("competitors", [])
            home_team = next((c.get("name") for c in competitors if c.get("qualifier") == "home"), "Home")
            away_team = next((c.get("name") for c in competitors if c.get("qualifier") == "away"), "Away")
            home_competitor_id, away_competitor_id = _extract_competitor_ids(competitors)
            competition_id = competition.get("id")

            if competition_id:
                home_competitor_id = home_competitor_id or get_competitor_id(competition_id, home_team)
                away_competitor_id = away_competitor_id or get_competitor_id(competition_id, away_team)
                upsert_competitors_for_game(
                    competition_id=competition_id,
                    home_team=home_team,
                    home_competitor_id=home_competitor_id,
                    away_team=away_team,
                    away_competitor_id=away_competitor_id,
                )

            game = {
                "sport_event_id": sport_event.get("id"),
                "league": competition.get("name", "Unknown League"),
                "competition_id": competition_id,
                "country": (sport_event_context.get("category") or {}).get("name", "World"),
                "home": home_team,
                "away": away_team,
                "competitor_id": home_competitor_id,
                "competitor2_id": away_competitor_id,
                "score_home": status_obj.get("home_score", 0),
                "score_away": status_obj.get("away_score", 0),
                "status": str(status_obj.get("match_status", "LIVE")).upper(),
                "minute": (status_obj.get("clock") or {}).get("played", "N/A"),
                "venue": (sport_event.get("venue") or {}).get("name", "TBA"),
            }

            upsert_sport_event_competitors(
                sport_event_id=sport_event.get("id"),
                competition_id=competition_id,
                home_team=home_team,
                away_team=away_team,
                competitor_id=home_competitor_id,
                competitor2_id=away_competitor_id,
            )

            games.append(game)

        return games

    except requests.exceptions.HTTPError as e:
        print(f"API Error: {e}")
        print(f"Body: {getattr(e.response, 'text', '')}")
        return []
    except Exception as e:
        print(f"Error: {e}")
        return []


def fetch_sport_event_timeline(sport_event_id):
    """
    Fetch the regular Sport Event Timeline for a match (play-by-play, goals, cards, etc.).
    Works for both live and past games. Returns raw API response or None on error.
    Endpoint: GET .../sport_events/{sport_event_id}/timeline.json
    """
    if not sport_event_id or not str(sport_event_id).strip():
        return None
    event_id = str(sport_event_id).strip()
    url = f"{SPORTRADAR_BASE_URL}/en/sport_events/{event_id}/timeline.json"
    try:
        data = _get_json(url, timeout=20)
        return data
    except SportradarAPIError:
        return None


def get_test_game():
    """
    Return a test game when there are no live games.
    """
    return {
        "sport_event_id": "sr:sport_event:61300703",
        "league": "Test League",
        "country": "Test",
        "home": "Ryan",
        "away": "World",
        "score_home": 2,
        "score_away": 1,
        "status": "LIVE",
        "minute": "45",
        "venue": "Test Stadium",
    }
