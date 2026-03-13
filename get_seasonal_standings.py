import requests
import os
import time
from dotenv import load_dotenv

load_dotenv()

SPORTRADAR_API_KEY = os.getenv("SPORTRADAR_API_KEY")
SPORTRADAR_BASE_URL = "https://api.sportradar.com/soccer/trial/v4"


def fetch_season_standings(season_urn):
    """
    Fetch season standings for the given season URN.
    Returns the raw JSON response or None on error.
    """
    if not SPORTRADAR_API_KEY or not season_urn:
        return None

    headers = {"accept": "application/json"}
    params = {"api_key": SPORTRADAR_API_KEY}

    url = f"{SPORTRADAR_BASE_URL}/en/seasons/{season_urn}/standings.json"
    try:
        resp = requests.get(url, headers=headers, params=params, timeout=10)
        # small pause between attempts
        print("Printing RESP: ",resp)
        time.sleep(0.1)
        if resp.status_code == 200:
            print("[Debug] Seasonal Stadning Grab Success Returning Full Standings")
            return resp.json()
        else:
            try:
                body = resp.text
            except Exception:
                body = "<no body>"
            print(f"[DEBUG] Standings URL {url} returned {resp.status_code}: {body}")
    except requests.exceptions.RequestException as e:
        print(f"[DEBUG] Error requesting standings {url}: {e}")

    print("[DEBUG] Error requesting standings returned none at the end")
    return None


