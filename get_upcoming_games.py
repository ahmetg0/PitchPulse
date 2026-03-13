import requests
import os
import time
from dotenv import load_dotenv

load_dotenv()

SPORTRADAR_API_KEY = os.getenv("SPORTRADAR_API_KEY")
SPORTRADAR_BASE_URL = "https://api.sportradar.com/soccer/trial/v4"

# Static competitor URN to query schedules for — example placeholder URN.
# Replace with a real competitor URN from the SportRadar documentation if desired.
# Example: a well-known team URN from docs could be something like "sr:competitor:17"
COMPETITOR_URN = os.getenv("SPORTRADAR_COMPETITOR_URN", "sr:competitor:17")


def fetch_upcoming_games(limit=5):
    """
    Fetch upcoming soccer games (next scheduled) from SportRadar v4 API.
    Returns a list of game dicts compatible with `fetch_all_live_games` output.
    """
    if not SPORTRADAR_API_KEY:
        print("Error: Missing SPORTRADAR_API_KEY")
        return []

    try:
        # Try competitor-specific schedules endpoint without locale first (some tiers omit locale)
        headers = {"accept": "application/json"}
        params = {"api_key": SPORTRADAR_API_KEY, "limit": limit}

        tried_urls = []

        # Candidate URLs to try in order (no locale first, then with /en)
        candidate_urls = [
            f"{SPORTRADAR_BASE_URL}/competitors/{COMPETITOR_URN}/schedules.json",
            f"{SPORTRADAR_BASE_URL}/en/competitors/{COMPETITOR_URN}/schedules.json",
            f"{SPORTRADAR_BASE_URL}/en/schedules/upcoming/summaries.json",
            f"{SPORTRADAR_BASE_URL}/schedules/upcoming/summaries.json",
        ]

        resp = None
        data = {}
        for url in candidate_urls:
            try:
                tried_urls.append(url)
                resp = requests.get(url, headers=headers, params=params, timeout=10)
                # brief pause between attempts to avoid rate spikes
                time.sleep(0.1)
                if resp.status_code == 200:
                    data = resp.json()
                    break
                else:
                    # Log non-200 for debugging
                    try:
                        body = resp.text
                    except Exception:
                        body = "<no body>"
                    print(f"[DEBUG] Upcoming URL {url} returned {resp.status_code}: {body}")
            except requests.exceptions.RequestException as e:
                print(f"[DEBUG] Error requesting {url}: {e}")

        if not data:
            # No successful response found
            return []

        resp.raise_for_status()
        data = resp.json()

        # The competitor schedules endpoint may return 'schedules' or 'summaries'
        summaries = data.get("schedules") or data.get("summaries") or []

        games = []
        for item in summaries[:limit]:
            # Different response shapes: item may be a schedule or a summary wrapper
            sport_event = item.get("sport_event") if isinstance(item, dict) and item.get("sport_event") else item
            sport_event = sport_event or {}
            sport_event_context = sport_event.get("sport_event_context", {})
            competition = sport_event_context.get("competition", {})

            competitors = sport_event.get("competitors", [])
            home_team = next((c.get("name") for c in competitors if c.get("qualifier") == "home"), "Home")
            away_team = next((c.get("name") for c in competitors if c.get("qualifier") == "away"), "Away")

            start_time = sport_event.get("scheduled") or sport_event.get("scheduled_at") or None

            game = {
                "sport_event_id": sport_event.get("id"),
                "league": competition.get("name", "Upcoming League"),
                "country": (sport_event_context.get("category") or {}).get("name", "World"),
                "home": home_team,
                "away": away_team,
                "score_home": 0,
                "score_away": 0,
                "status": "UPCOMING",
                "minute": start_time or "—",
                "venue": (sport_event.get("venue") or {}).get("name", "TBA"),
            }
            games.append(game)

        return games

    except requests.exceptions.HTTPError as e:
        print(f"API Error fetching upcoming games: {e}")
        return []
    except Exception as e:
        print(f"Error fetching upcoming games: {e}")
        return []
