import os
from flask import Flask, jsonify, send_from_directory, request, session, redirect, url_for
from flask_login import LoginManager, UserMixin, login_user, logout_user, current_user
from datetime import datetime, timezone
from authlib.integrations.flask_client import OAuth
from dotenv import load_dotenv
from get_live_games import (
    fetch_seasons_for_competition,
    fetch_schedule_for_season,
    fetch_competitor_ids_for_sport_event,
    fetch_sport_event_timeline,
    SportradarAPIError,
)
from get_team_stats import get_current_season_urn as get_season_urn_for_event
from get_seasonal_standings import fetch_season_standings
from schedule_cache import (
    init_db,
    read_schedule,
    write_schedule,
    read_competition_catalog,
    read_competition_seasons,
    write_competition_seasons,
    read_season_standings,
    write_season_standings,
    read_timeline,
    write_timeline,
    read_starting_lineups,
    write_starting_lineups,
    read_team_roster,
    write_team_roster,
    save_chat_message,
    get_chat_conversations_for_user,
    get_chat_conversation_for_user_game,
    get_chat_messages_for_user_game,
    delete_chat_conversation_for_user_game,
    clear_chat_history_for_user,
    get_competitor_id,
    get_sport_event_competitors,
    upsert_sport_event_competitors,
    find_season_id_for_sport_event,
    find_cached_game_for_sport_event,
    get_user_favorite_league,
    set_user_favorite_league,
    clear_user_favorite_league,
)
from get_team_roster import fetch_team_profile
from get_starting_lineups import fetch_starting_lineups

load_dotenv()
init_db()

app = Flask(__name__, static_folder="static")
app.secret_key = os.urandom(32)

# Flask-Login setup
login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = "login"

# OAuth setup
oauth = OAuth(app)
google = oauth.register(
    name="google",
    client_id=os.getenv("GOOGLE_CLIENT_ID"),
    client_secret=os.getenv("GOOGLE_CLIENT_SECRET"),
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)


class User(UserMixin):
    def __init__(self, id, email, name, picture):
        self.id = id
        self.email = email
        self.name = name
        self.picture = picture


@login_manager.user_loader
def load_user(user_id):
    # Load user from session
    user_data = session.get("user")
    if user_data and user_data.get("id") == user_id:
        return User(
            id=user_data["id"],
            email=user_data["email"],
            name=user_data["name"],
            picture=user_data.get("picture", "")
        )
    return None


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/game-detail.html")
def game_detail():
    return send_from_directory(app.static_folder, "game-detail.html")

@app.get("/settings.html")
def settings():
    return send_from_directory(app.static_folder, "settings.html")

@app.get("/static/<path:filename>")
def static_files(filename):
    return send_from_directory(app.static_folder, filename)


@app.get("/api/competitions")
def competitions():
    try:
        competitions_list = read_competition_catalog()
        return jsonify({
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "competitions": competitions_list,
            "total_competitions": len(competitions_list),
        })
    except SportradarAPIError as e:
        status = e.status_code or 502
        return jsonify({
            "error": "Failed to fetch competitions",
            "details": e.details or str(e),
            "upstream_status": status,
        }), status
    except Exception as e:
        return jsonify({"error": "Failed to fetch competitions", "details": str(e)}), 500


@app.get("/api/seasons")
def seasons():
    competition_id = request.args.get("competition_id", "").strip()
    refresh = request.args.get("refresh", "").strip().lower() in {"1", "true", "yes"}
    if not competition_id:
        return jsonify({"error": "Missing competition_id"}), 400

    catalog_ids = {
        str(competition.get("id") or "").strip()
        for competition in read_competition_catalog()
        if competition.get("id")
    }
    if competition_id not in catalog_ids:
        return jsonify({"error": "Competition is not allowed"}), 403

    try:
        if not refresh:
            cached_seasons = read_competition_seasons(competition_id)
            if isinstance(cached_seasons, list):
                return jsonify({
                    "generated_at": datetime.now(timezone.utc).isoformat(),
                    "competition_id": competition_id,
                    "seasons": cached_seasons,
                    "total_seasons": len(cached_seasons),
                    "source": "cache",
                })

        seasons_list = fetch_seasons_for_competition(competition_id)
        write_competition_seasons(competition_id, seasons_list)
        return jsonify({
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "competition_id": competition_id,
            "seasons": seasons_list,
            "total_seasons": len(seasons_list),
            "source": "api",
        })
    except SportradarAPIError as e:
        status = e.status_code or 502
        return jsonify({
            "error": "Failed to fetch seasons",
            "details": e.details or str(e),
            "upstream_status": status,
        }), status
    except Exception as e:
        return jsonify({"error": "Failed to fetch seasons", "details": str(e)}), 500


@app.get("/api/season-schedule")
def season_schedule():
    season_id = request.args.get("season_id", "").strip()
    refresh = request.args.get("refresh", "").strip().lower() in {"1", "true", "yes"}
    if not season_id:
        return jsonify({"error": "Missing season_id"}), 400

    try:
        if not refresh:
            cached_payload = read_schedule(season_id)
            if cached_payload:
                return jsonify(cached_payload)

        games = fetch_schedule_for_season(season_id)
        grouped = {
            "past": [game for game in games if game.get("bucket") == "past"],
            "current": [game for game in games if game.get("bucket") == "current"],
            "future": [game for game in games if game.get("bucket") == "future"],
        }

        payload = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "season_id": season_id,
            "total_games": len(games),
            "games": games,
            "groups": grouped,
        }

        write_schedule(season_id, payload)

        try:
            standings_payload = fetch_season_standings(season_id)
            if standings_payload is not None:
                write_season_standings(
                    season_id,
                    {
                        "season_urn": season_id,
                        "standings": standings_payload,
                    },
                )
        except Exception:
            pass

        return jsonify(payload)
    except SportradarAPIError as e:
        status = e.status_code or 502
        return jsonify({
            "error": "Failed to fetch season schedule",
            "details": e.details or str(e),
            "upstream_status": status,
        }), status
    except Exception as e:
        return jsonify({"error": "Failed to fetch season schedule", "details": str(e)}), 500


@app.get("/api/default-selection")
def default_selection():
    """
    Resolve default competition and season for homepage selection.
    Priority:
    1) DEFAULT_COMPETITION_ID from env (if valid), else first competition
    2) DEFAULT_SEASON_ID from env if valid for selected competition
    3) latest available season for selected competition
    """
    env_competition_id = os.getenv("DEFAULT_COMPETITION_ID", "").strip() or None
    env_season_id = os.getenv("DEFAULT_SEASON_ID", "").strip() or None

    try:
        competitions_list = read_competition_catalog()
        if not competitions_list:
            return jsonify({"error": "No allowed competitions available"}), 404

        selected_competition = None
        if env_competition_id:
            selected_competition = next(
                (c for c in competitions_list if str(c.get("id") or "").strip() == env_competition_id),
                None,
            )

        if not selected_competition:
            selected_competition = competitions_list[0]

        seasons_list = read_competition_seasons(selected_competition["id"])
        if not isinstance(seasons_list, list) or not seasons_list:
            seasons_list = fetch_seasons_for_competition(selected_competition["id"])
            write_competition_seasons(selected_competition["id"], seasons_list)

        selected_season_id = None
        if env_season_id and any(season["id"] == env_season_id for season in seasons_list):
            selected_season_id = env_season_id

        if not selected_season_id and seasons_list:
            selected_season_id = seasons_list[0]["id"]

        return jsonify({
            "competition_id": selected_competition["id"],
            "season_id": selected_season_id,
        })
    except SportradarAPIError as e:
        status = e.status_code or 502
        return jsonify({
            "error": "Failed to resolve default selection",
            "details": e.details or str(e),
            "upstream_status": status,
        }), status
    except Exception as e:
        return jsonify({"error": "Failed to resolve default selection", "details": str(e)}), 500


@app.post("/api/resolve-competitor-ids")
def resolve_competitor_ids():
    data = request.get_json(silent=True) or {}
    sport_event_id = str(data.get("sport_event_id") or "").strip()
    competition_id = str(data.get("competition_id") or "").strip()
    home_team = str(data.get("home_team") or "").strip()
    away_team = str(data.get("away_team") or "").strip()
    request_home_id = str(data.get("competitor_id") or "").strip()
    request_away_id = str(data.get("competitor2_id") or "").strip()

    resolved_competition_id = competition_id
    resolved_home_team = home_team
    resolved_away_team = away_team
    home_id = request_home_id
    away_id = request_away_id

    if sport_event_id:
        event_row = get_sport_event_competitors(sport_event_id)
        if event_row:
            resolved_competition_id = resolved_competition_id or event_row.get("competition_id", "")
            resolved_home_team = resolved_home_team or event_row.get("home_team", "")
            resolved_away_team = resolved_away_team or event_row.get("away_team", "")
            home_id = str(event_row.get("competitor_id") or "").strip()
            away_id = str(event_row.get("competitor2_id") or "").strip()

        if not home_id or not away_id:
            lineup_home_id, lineup_away_id = fetch_competitor_ids_for_sport_event(sport_event_id)
            home_id = home_id or lineup_home_id
            away_id = away_id or lineup_away_id

            if resolved_competition_id or resolved_home_team or resolved_away_team:
                upsert_sport_event_competitors(
                    sport_event_id=sport_event_id,
                    competition_id=resolved_competition_id,
                    home_team=resolved_home_team,
                    away_team=resolved_away_team,
                    competitor_id=home_id,
                    competitor2_id=away_id,
                )

    if (not home_id or not away_id) and resolved_competition_id:
        home_id = home_id or (get_competitor_id(resolved_competition_id, resolved_home_team) or "")
        away_id = away_id or (get_competitor_id(resolved_competition_id, resolved_away_team) or "")

    if sport_event_id and (home_id or away_id):
        upsert_sport_event_competitors(
            sport_event_id=sport_event_id,
            competition_id=resolved_competition_id,
            home_team=resolved_home_team,
            away_team=resolved_away_team,
            competitor_id=home_id,
            competitor2_id=away_id,
        )

    return jsonify({
        "sport_event_id": sport_event_id,
        "competition_id": resolved_competition_id,
        "home_team": resolved_home_team,
        "away_team": resolved_away_team,
        "competitor_id": str(home_id or ""),
        "competitor2_id": str(away_id or ""),
    })


@app.post("/api/season-standings")
def season_standings():
    """
    Return season standings and the specific rows for the home and away teams.
    Expects JSON body with `sport_event_id`, `home_team`, `away_team`.
    """
    data = request.get_json(silent=True) or {}
    refresh = request.args.get("refresh", "").strip().lower() in {"1", "true", "yes"} or bool(data.get("refresh"))
    sport_event_id = data.get("sport_event_id")
    home_team = data.get("home_team", "").strip()
    away_team = data.get("away_team", "").strip()
    season_id = str(data.get("season_id") or "").strip()

    if not sport_event_id or not home_team or not away_team:
        return jsonify({"error": "Missing sport_event_id or team names"}), 400

    try:
        cached_season_id = season_id or find_season_id_for_sport_event(sport_event_id)

        if not refresh and cached_season_id:
            cached_payload = read_season_standings(cached_season_id)
            if isinstance(cached_payload, dict) and cached_payload.get("standings") is not None:
                return jsonify(cached_payload)

        season_urn = cached_season_id or get_season_urn_for_event(sport_event_id)
        if not season_urn:
            return jsonify({"error": "Could not determine season for this event"}), 404

        standings = fetch_season_standings(season_urn)
        if standings is None:
            return jsonify({"error": "Failed to fetch standings from upstream"}), 502

        payload = {
            "season_urn": season_urn,
            "standings": standings,
        }
        write_season_standings(season_urn, payload)
        return jsonify(payload)
    except Exception as e:
        print(f"Error fetching season standings: {e}")
        return jsonify({"error": str(e)}), 500


@app.get("/api/user")
def get_user():
    """Get current user info"""
    if current_user.is_authenticated:
        return jsonify({
            "authenticated": True,
            "user": {
                "id": current_user.id,
                "email": current_user.email,
                "name": current_user.name,
                "picture": current_user.picture
            }
        })
    return jsonify({"authenticated": False})


@app.get("/api/user-favorite-league")
def get_user_favorite_league_api():
    if not current_user.is_authenticated:
        return jsonify({"favorite_league_id": ""})

    favorite_league_id = get_user_favorite_league(current_user.id)
    return jsonify({"favorite_league_id": favorite_league_id})


@app.post("/api/user-favorite-league")
def set_user_favorite_league_api():
    if not current_user.is_authenticated:
        return jsonify({"error": "Authentication required"}), 401

    data = request.get_json(silent=True) or {}
    competition_id = str(data.get("competition_id") or "").strip()
    if not competition_id:
        return jsonify({"error": "Missing competition_id"}), 400

    catalog_ids = {
        str(competition.get("id") or "").strip()
        for competition in read_competition_catalog()
        if competition.get("id")
    }
    if competition_id not in catalog_ids:
        return jsonify({"error": "Competition is not allowed"}), 403

    saved = set_user_favorite_league(current_user.id, competition_id)
    if not saved:
        return jsonify({"error": "Failed to save favorite league"}), 500

    return jsonify({"ok": True, "favorite_league_id": competition_id})


@app.delete("/api/user-favorite-league")
def clear_user_favorite_league_api():
    if not current_user.is_authenticated:
        return jsonify({"error": "Authentication required"}), 401

    cleared = clear_user_favorite_league(current_user.id)
    if not cleared:
        return jsonify({"error": "Failed to clear favorite league"}), 500

    return jsonify({"ok": True})


@app.get("/api/chat-history")
def chat_history_list():
    if not current_user.is_authenticated:
        return jsonify({"error": "Authentication required"}), 401

    conversations = get_chat_conversations_for_user(current_user.id)
    return jsonify({
        "conversations": conversations,
        "total": len(conversations),
    })


@app.get("/api/chat-history/<path:sport_event_id>")
def chat_history_messages(sport_event_id):
    if not current_user.is_authenticated:
        return jsonify({"error": "Authentication required"}), 401

    event_id = str(sport_event_id or "").strip()
    if not event_id:
        return jsonify({"error": "Missing sport_event_id"}), 400

    messages = get_chat_messages_for_user_game(current_user.id, event_id)
    return jsonify({
        "sport_event_id": event_id,
        "messages": messages,
        "total": len(messages),
    })


@app.delete("/api/chat-history")
def clear_chat_history_api():
    if not current_user.is_authenticated:
        return jsonify({"error": "Authentication required"}), 401

    cleared = clear_chat_history_for_user(current_user.id)
    if not cleared:
        return jsonify({"error": "Failed to clear chat history"}), 500

    return jsonify({"ok": True})


@app.delete("/api/chat-history/<path:sport_event_id>")
def delete_chat_history_item_api(sport_event_id):
    if not current_user.is_authenticated:
        return jsonify({"error": "Authentication required"}), 401

    event_id = str(sport_event_id or "").strip()
    if not event_id:
        return jsonify({"error": "Missing sport_event_id"}), 400

    deleted = delete_chat_conversation_for_user_game(current_user.id, event_id)
    if not deleted:
        return jsonify({"error": "Conversation not found"}), 404

    return jsonify({"ok": True, "sport_event_id": event_id})


@app.get("/api/chat-history/<path:sport_event_id>/context")
def chat_history_context(sport_event_id):
    if not current_user.is_authenticated:
        return jsonify({"error": "Authentication required"}), 401

    event_id = str(sport_event_id or "").strip()
    if not event_id:
        return jsonify({"error": "Missing sport_event_id"}), 400

    conversation = get_chat_conversation_for_user_game(current_user.id, event_id)
    if not conversation:
        return jsonify({"error": "Conversation not found"}), 404

    event_competitors = get_sport_event_competitors(event_id) or {}
    cached_game = find_cached_game_for_sport_event(event_id) or {}
    competition_id = str(event_competitors.get("competition_id") or "").strip()
    if not competition_id:
        competition_id = str(cached_game.get("competition_id") or "").strip()

    competition_name = ""
    if competition_id:
        competition_name = next(
            (str(c.get("name") or "").strip() for c in read_competition_catalog() if str(c.get("id") or "").strip() == competition_id),
            "",
        )

    game_payload = {
        "sport_event_id": event_id,
        "season_id": str(cached_game.get("season_id") or "").strip() or find_season_id_for_sport_event(event_id),
        "home": str(cached_game.get("home") or "").strip() or conversation.get("home_team") or "Home",
        "away": str(cached_game.get("away") or "").strip() or conversation.get("away_team") or "Away",
        "start_time": str(cached_game.get("start_time") or "").strip() or conversation.get("start_time") or "",
        "competition_id": competition_id,
        "league": str(cached_game.get("league") or "").strip() or competition_name or "Unknown Competition",
        "country": str(cached_game.get("country") or "").strip(),
        "venue": str(cached_game.get("venue") or "").strip(),
        "status": str(cached_game.get("status") or "").strip() or "history",
        "minute": str(cached_game.get("minute") or "").strip() or "—",
        "score_home": cached_game.get("score_home", 0),
        "score_away": cached_game.get("score_away", 0),
        "competitor_id": str(event_competitors.get("competitor_id") or cached_game.get("competitor_id") or "").strip(),
        "competitor2_id": str(event_competitors.get("competitor2_id") or cached_game.get("competitor2_id") or "").strip(),
    }

    return jsonify({"game": game_payload})


@app.post("/api/chat-history")
def save_chat_history_message():
    if not current_user.is_authenticated:
        return jsonify({"error": "Authentication required"}), 401

    data = request.get_json(silent=True) or {}
    sport_event_id = str(data.get("sport_event_id") or "").strip()
    role = str(data.get("role") or "").strip().lower()
    content = str(data.get("content") or "").strip()
    home_team = str(data.get("home_team") or "").strip()
    away_team = str(data.get("away_team") or "").strip()
    start_time = str(data.get("start_time") or "").strip()

    if not sport_event_id:
        return jsonify({"error": "Missing sport_event_id"}), 400
    if role not in {"user", "assistant"}:
        return jsonify({"error": "Invalid role"}), 400
    if not content:
        return jsonify({"error": "Missing content"}), 400

    saved = save_chat_message(
        user_id=current_user.id,
        sport_event_id=sport_event_id,
        role=role,
        content=content,
        home_team=home_team,
        away_team=away_team,
        start_time=start_time,
    )

    if not saved:
        return jsonify({"error": "Failed to save chat message"}), 500

    return jsonify({"ok": True})


@app.get("/login")
def login():
    """Initiate Google OAuth login"""
    redirect_uri = url_for("auth_callback", _external=True)
    return google.authorize_redirect(redirect_uri)


@app.get("/auth/callback")
def auth_callback():
    """Handle OAuth callback"""
    try:
        token = google.authorize_access_token()
        user_info = token.get("userinfo")
        
        if user_info:
            user = User(
                id=user_info["sub"],
                email=user_info["email"],
                name=user_info.get("name", ""),
                picture=user_info.get("picture", "")
            )
            
            # Store user data in session
            session["user"] = {
                "id": user.id,
                "email": user.email,
                "name": user.name,
                "picture": user.picture
            }
            
            login_user(user)
            return redirect("/")
        else:
            return redirect("/?error=login_failed")
    except Exception as e:
        print(f"OAuth error: {e}")
        return redirect("/?error=login_failed")


@app.get("/logout")
def logout():
    """Logout user"""
    logout_user()
    session.pop("user", None)
    return redirect("/")

@app.get("/api/sport-event/<path:sport_event_id>/timeline")
def get_event_timeline(sport_event_id):
    """Return Sport Event Timeline (play-by-play) for a match. Works for past and live games."""
    event_id = str(sport_event_id or "").strip()
    refresh = request.args.get("refresh", "").strip().lower() in {"1", "true", "yes"}
    if not event_id:
        return jsonify({"error": "Missing sport_event_id"}), 400

    if not refresh:
        cached_timeline = read_timeline(event_id)
        if isinstance(cached_timeline, dict):
            return jsonify(cached_timeline)

    data = fetch_sport_event_timeline(event_id)
    if data is None:
        return jsonify({
            "error": "Timeline not available",
            "detail": "No timeline data returned for this event (may be unsupported coverage).",
            "sport_event_id": event_id,
        }), 404
    write_timeline(event_id, data)
    return jsonify(data)


@app.get("/api/rosters")
def get_rosters():
    # 1. Get Event ID
    sport_event_id = request.args.get("sport_event_id", "").strip()
    refresh = request.args.get("refresh", "").strip().lower() in {"1", "true", "yes"}
    if not sport_event_id:
        return jsonify({"error": "Missing sport_event_id"}), 400

    # 2. Resolve Competitor IDs (Home/Away)
    # We try our DB cache first, then the API lookup
    home_id = None
    away_id = None
    
    # Try DB
    row = get_sport_event_competitors(sport_event_id)
    if row and row.get("competitor_id") and row.get("competitor2_id"):
        home_id = row["competitor_id"]
        away_id = row["competitor2_id"]
    else:
        # Try API lookup
        try:
            h_id, a_id = fetch_competitor_ids_for_sport_event(sport_event_id)
            home_id = h_id
            away_id = a_id
        except Exception as e:
            print(f"Error resolving IDs: {e}")

    if not home_id or not away_id:
        return jsonify({"error": "Could not resolve team IDs for this match"}), 404

    home_data = None
    away_data = None

    if not refresh:
        home_data = read_team_roster(home_id)
        away_data = read_team_roster(away_id)

    if not home_data:
        home_data = fetch_team_profile(home_id)
        if home_data:
            write_team_roster(home_id, home_data)

    if not away_data:
        away_data = fetch_team_profile(away_id)
        if away_data:
            write_team_roster(away_id, away_data)

    if not home_data and not away_data:
        return jsonify({"error": "Roster data unavailable"}), 502

    return jsonify({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "home": home_data,
        "away": away_data
    })

@app.get("/api/starting-lineups")
def get_starting_lineups():
    sport_event_id = request.args.get("sport_event_id", "").strip()
    refresh = request.args.get("refresh", "").strip().lower() in {"1", "true", "yes"}
    if not sport_event_id:
        return jsonify({"error": "Missing sport_event_id"}), 400

    try:
        if not refresh:
            cached_lineups = read_starting_lineups(sport_event_id)
            if isinstance(cached_lineups, dict):
                if cached_lineups.get("status") == 404:
                    return jsonify({"error": "Lineups not released yet"}), 404
                return jsonify({
                    "generated_at": datetime.now(timezone.utc).isoformat(),
                    "lineups": cached_lineups
                })

        data = fetch_starting_lineups(sport_event_id)
        if data is not None:
            write_starting_lineups(sport_event_id, data)

        # Handle the custom 404 dict we defined above
        if data and isinstance(data, dict) and data.get("status") == 404:
            return jsonify({"error": "Lineups not released yet"}), 404
            
        return jsonify({
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "lineups": data
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8000, debug=True)
