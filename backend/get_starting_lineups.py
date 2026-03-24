import os
import requests
from dotenv import load_dotenv

load_dotenv()

SPORTRADAR_API_KEY = os.getenv("SPORTRADAR_API_KEY")
SPORTRADAR_BASE_URL = "https://api.sportradar.com/soccer/trial/v4"

def fetch_starting_lineups(sport_event_id):
    """
    Fetch confirmed starting lineups for a specific match.
    Endpoint: /sport_events/{id}/lineups.json
    """
    if not SPORTRADAR_API_KEY or not sport_event_id:
        return None

    url = f"{SPORTRADAR_BASE_URL}/en/sport_events/{sport_event_id}/lineups.json"
    headers = {"accept": "application/json"}
    params = {"api_key": SPORTRADAR_API_KEY}

    try:
        resp = requests.get(url, headers=headers, params=params, timeout=10)
        if resp.status_code == 200:
            return resp.json()
        elif resp.status_code == 404:
            # 404 is normal if the game is in the future and lineups aren't out yet
            return {"status": 404, "message": "Lineups not released yet"}
    except Exception as e:
        print(f"[DEBUG] Error fetching starting lineups: {e}")

    return None