import os
import requests
from dotenv import load_dotenv

load_dotenv()

SPORTRADAR_API_KEY = os.getenv("SPORTRADAR_API_KEY")
SPORTRADAR_BASE_URL = "https://api.sportradar.com/soccer/trial/v4"

def fetch_team_profile(competitor_id):
    """
    Fetch the full profile (roster) for a competitor.
    """
    if not SPORTRADAR_API_KEY or not competitor_id:
        return None

    # Endpoint: /competitors/{urn}/profile.json
    url = f"{SPORTRADAR_BASE_URL}/en/competitors/{competitor_id}/profile.json"
    
    headers = {"accept": "application/json"}
    params = {"api_key": SPORTRADAR_API_KEY}

    try:
        resp = requests.get(url, headers=headers, params=params, timeout=10)
        if resp.status_code == 200:
            return resp.json()
        else:
            print(f"[DEBUG] Team profile fetch failed for {competitor_id}: {resp.status_code}")
    except Exception as e:
        print(f"[DEBUG] Exception fetching team profile: {e}")

    return None