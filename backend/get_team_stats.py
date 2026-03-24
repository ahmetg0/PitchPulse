import requests
import os
import json
from dotenv import load_dotenv
import time

load_dotenv()

SPORTRADAR_API_KEY = os.getenv("SPORTRADAR_API_KEY")
SPORTRADAR_BASE_URL = "https://api.sportradar.com/soccer/trial/v4"


def get_current_season_urn(event_id=None):
    """
    Get the current season URN.

    If `event_id` is provided, attempt to fetch the event/schedule summary
    and extract the season URN for that specific event. Otherwise fall back
    to the live schedules summary to derive a current season.
    """
    headers = {"accept": "application/json"}
    params = {"api_key": SPORTRADAR_API_KEY, "limit": 1}

    # If an event_id is provided, try event-specific endpoints first
    if event_id:
        candidate_urls = [
            f"{SPORTRADAR_BASE_URL}/en/sport_events/{event_id}/summary.json",
            f"{SPORTRADAR_BASE_URL}/en/schedules/{event_id}/summary.json",
            f"{SPORTRADAR_BASE_URL}/en/schedules/{event_id}.json",
        ]

        for url in candidate_urls:
            try:
                resp = requests.get(url, headers=headers, params={"api_key": SPORTRADAR_API_KEY}, timeout=10)
                if resp.status_code != 200:
                    continue
                data = resp.json()
                # Look for sport_event -> sport_event_context -> season -> id
                sport_event = data.get("sport_event") or data.get("sport_event", {})
                if not sport_event:
                    # some responses wrap under 'sport_event' key differently
                    sport_event = data.get("sport_event", {})

                sport_event_context = sport_event.get("sport_event_context", {}) if isinstance(sport_event, dict) else {}
                season = sport_event_context.get("season", {})
                season_id = season.get("id") if isinstance(season, dict) else None
                if season_id:
                    return season_id
            except Exception:
                continue

    # Fallback: use live schedules summary to infer a current season
    try:
        url = f"{SPORTRADAR_BASE_URL}/en/schedules/live/summaries.json"
        params = {
            "api_key": SPORTRADAR_API_KEY,
            "limit": 1
        }
        headers = {"accept": "application/json"}
        
        response = requests.get(url, headers=headers, params=params, timeout=10)
        response.raise_for_status()

        data = response.json()
        summaries = data.get("summaries", [])

        if summaries:
            sport_event = summaries[0].get("sport_event", {})
            sport_event_context = sport_event.get("sport_event_context", {})
            season = sport_event_context.get("season", {})
            return season.get("id")

        return None

    except Exception as e:
        print(f"Error getting current season: {e}")
        return None


def fetch_team_stats_by_name(season_urn, team_name):
    """
    Fetch statistics for a team by name in a given season.
    """
    if not season_urn:
        return None
    
    try:
        # 1. Get all competitors to find the ID
        url = f"{SPORTRADAR_BASE_URL}/en/seasons/{season_urn}/competitors.json"
        params = {"api_key": SPORTRADAR_API_KEY}
        headers = {
            "accept": "application/json",
            "x-api-key": SPORTRADAR_API_KEY,
        }
        
        response = requests.get(url, headers=headers, params=params, timeout=10)
        response.raise_for_status()
        
        data = response.json()
        competitors = data.get("season_competitors", [])
        if not competitors:
            competitors = data.get("competitors", [])
        
        # 2. Find the team ID
        team_urn = None
        for competitor in competitors:
            if competitor.get("name", "").lower() == team_name.lower():
                team_urn = competitor.get("id")
                break
        
        if not team_urn:
            print(f"Could not find team named '{team_name}' in season '{season_urn}'")
            return None
        
        # 3. Fetch the stats
        url = f"{SPORTRADAR_BASE_URL}/en/seasons/{season_urn}/competitors/{team_urn}/statistics.json"
        
        response = requests.get(url, headers=headers, params=params, timeout=10)
        response.raise_for_status()
        
        data = response.json()
        
        # --- FIXED LOGIC HERE ---
        # The stats are nested inside 'competitor' -> 'statistics'
        if "competitor" in data and "statistics" in data["competitor"]:
            return parse_team_stats(data["competitor"]["statistics"])
            
        print(f"Stats found, but structure was unexpected. Keys: {data.keys()}")
        return None
    
    except requests.exceptions.RequestException as e:
        print(f"API Error fetching stats for {team_name}: {e}")
        return None
    except Exception as e:
        print(f"Error processing team stats for {team_name}: {e}")
        return None

def get_season_urn_for_event(sport_event_id):
    """
    Get the exact season URN for a specific sport event (game).
    """
    try:
        url = f"{SPORTRADAR_BASE_URL}/en/sport_events/{sport_event_id}/summary.json"
        params = {"api_key": SPORTRADAR_API_KEY}
        headers = {"accept": "application/json"}
        
        response = requests.get(url, headers=headers, params=params, timeout=10)
        time.sleep(0.2)
        response.raise_for_status()
        
        data = response.json()
        sport_event = data.get("sport_event", {})
        sport_event_context = sport_event.get("sport_event_context", {})
        season = sport_event_context.get("season", {})
        
        return season.get("id")
    
    except Exception as e:
        print(f"Error getting season for event {sport_event_id}: {e}")
        return None
    
def parse_team_stats(comp_stats):
    """
    Parse competitor statistics, mapping API keys to our desired format.
    """
    stats = {}
    
    # Map API keys (left) to Output keys (right)
    # Note: Wins/Losses/Points are NOT in this specific API endpoint response
    key_map = {
        "matches_played": "matches_played",
        "goals_scored": "goals_for",       # Mapped from goals_scored
        "goals_conceded": "goals_against", # Mapped from goals_conceded
        "yellow_cards": "yellow_cards",
        "red_cards": "red_cards",
        "corner_kicks": "corners",         # Extra stat available
        "average_ball_possession": "possession" # Extra stat available
    }
    
    for api_key, output_key in key_map.items():
        if api_key in comp_stats:
            stats[output_key] = comp_stats[api_key]
            
    # Manually calculate goal difference if possible
    if "goals_for" in stats and "goals_against" in stats:
        stats["goal_diff"] = stats["goals_for"] - stats["goals_against"]

    return stats if stats else None

# --- Quick Test Block ---
if __name__ == "__main__":
    # You can manually test with the season ID you saw in your debug output
    season = "sr:season:131873" 
    team = "Fatih Karagumruk Istanbul"
    
    print(f"Fetching fixed stats for {team}...")
    stats = fetch_team_stats_by_name(season, team)
    print(stats)