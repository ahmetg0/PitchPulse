import json
import os
import sqlite3
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "schedule_cache.db")


def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schedule_cache (
                season_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS competitor_index (
                competition_id TEXT NOT NULL,
                team_name_normalized TEXT NOT NULL,
                team_name TEXT NOT NULL,
                competitor_id TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (competition_id, team_name_normalized)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sport_event_competitors (
                sport_event_id TEXT PRIMARY KEY,
                competition_id TEXT,
                home_team TEXT,
                away_team TEXT,
                competitor_id TEXT,
                competitor2_id TEXT,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS competition_catalog (
                competition_id TEXT PRIMARY KEY,
                competition_name TEXT NOT NULL,
                sort_order INTEGER NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                sport_event_id TEXT NOT NULL,
                home_team TEXT,
                away_team TEXT,
                start_time TEXT,
                preview_title TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(user_id, sport_event_id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(conversation_id) REFERENCES chat_conversations(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS competition_seasons_cache (
                competition_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS season_standings_cache (
                season_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sport_event_timeline_cache (
                sport_event_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sport_event_starting_lineups_cache (
                sport_event_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS team_roster_cache (
                competitor_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_favorite_leagues (
                user_id TEXT PRIMARY KEY,
                competition_id TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.commit()


def _normalize_team_name(team_name):
    return " ".join(str(team_name or "").strip().lower().split())


def _is_valid_payload(payload):
    if not isinstance(payload, dict):
        return False

    games = payload.get("games")
    groups = payload.get("groups")
    if not isinstance(games, list) or not isinstance(groups, dict):
        return False

    return all(isinstance(groups.get(key), list) for key in ("past", "current", "future"))


def read_schedule(season_id):
    if not season_id:
        return None

    try:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute(
                "SELECT payload FROM schedule_cache WHERE season_id = ?",
                (season_id,),
            ).fetchone()

        if not row:
            return None

        payload = json.loads(row[0])
        return payload if _is_valid_payload(payload) else None
    except (sqlite3.Error, json.JSONDecodeError):
        return None


def get_cached_past_event_ids(limit=5):
    """
    Return up to `limit` sport_event_ids from past games in any cached schedule.
    Used for testing (e.g. timeline API) when you need known past event IDs.
    """
    out = []
    try:
        with sqlite3.connect(DB_PATH) as conn:
            rows = conn.execute(
                "SELECT payload FROM schedule_cache ORDER BY updated_at DESC",
            ).fetchall()
        for (raw,) in rows:
            if len(out) >= limit:
                break
            try:
                payload = json.loads(raw)
                if not _is_valid_payload(payload):
                    continue
                past = payload.get("groups") or {}
                if not isinstance(past, dict):
                    past = {}
                past_list = past.get("past") if isinstance(past.get("past"), list) else []
                for game in past_list:
                    if len(out) >= limit:
                        break
                    eid = (game.get("sport_event_id") or "").strip()
                    if eid and eid not in out:
                        out.append(eid)
            except (json.JSONDecodeError, TypeError):
                continue
        return out
    except sqlite3.Error:
        return []


def find_season_id_for_sport_event(sport_event_id):
    event_id = str(sport_event_id or "").strip()
    if not event_id:
        return ""

    try:
        with sqlite3.connect(DB_PATH) as conn:
            rows = conn.execute(
                "SELECT season_id, payload FROM schedule_cache ORDER BY updated_at DESC",
            ).fetchall()

        for season_id, payload_raw in rows:
            try:
                payload = json.loads(payload_raw)
            except (json.JSONDecodeError, TypeError):
                continue

            games = payload.get("games") if isinstance(payload, dict) else []
            if not isinstance(games, list):
                continue

            for game in games:
                if str((game or {}).get("sport_event_id") or "").strip() == event_id:
                    game_season_id = str((game or {}).get("season_id") or "").strip()
                    return game_season_id or str(season_id or "").strip()

        return ""
    except sqlite3.Error:
        return ""


def find_cached_game_for_sport_event(sport_event_id):
    event_id = str(sport_event_id or "").strip()
    if not event_id:
        return None

    try:
        with sqlite3.connect(DB_PATH) as conn:
            rows = conn.execute(
                "SELECT payload FROM schedule_cache ORDER BY updated_at DESC",
            ).fetchall()

        for (payload_raw,) in rows:
            try:
                payload = json.loads(payload_raw)
            except (json.JSONDecodeError, TypeError):
                continue

            games = payload.get("games") if isinstance(payload, dict) else []
            if not isinstance(games, list):
                continue

            for game in games:
                if str((game or {}).get("sport_event_id") or "").strip() == event_id:
                    return game if isinstance(game, dict) else None

        return None
    except sqlite3.Error:
        return None


def write_schedule(season_id, payload):
    if not season_id or not _is_valid_payload(payload):
        return

    updated_at = datetime.now(timezone.utc).isoformat()
    payload_copy = dict(payload)
    payload_copy["cached_at"] = updated_at

    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO schedule_cache (season_id, payload, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(season_id) DO UPDATE SET
                payload = excluded.payload,
                updated_at = excluded.updated_at
            """,
            (season_id, json.dumps(payload_copy), updated_at),
        )
        conn.commit()


def upsert_competitor(competition_id, team_name, competitor_id):
    normalized_name = _normalize_team_name(team_name)
    if not competition_id or not normalized_name or not competitor_id:
        return

    updated_at = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO competitor_index (
                competition_id,
                team_name_normalized,
                team_name,
                competitor_id,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(competition_id, team_name_normalized) DO UPDATE SET
                team_name = excluded.team_name,
                competitor_id = excluded.competitor_id,
                updated_at = excluded.updated_at
            """,
            (competition_id, normalized_name, str(team_name).strip(), str(competitor_id).strip(), updated_at),
        )
        conn.commit()


def upsert_competitors_for_game(competition_id, home_team, home_competitor_id, away_team, away_competitor_id):
    upsert_competitor(competition_id, home_team, home_competitor_id)
    upsert_competitor(competition_id, away_team, away_competitor_id)


def get_competitor_id(competition_id, team_name):
    normalized_name = _normalize_team_name(team_name)
    if not competition_id or not normalized_name:
        return None

    try:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute(
                """
                SELECT competitor_id
                FROM competitor_index
                WHERE competition_id = ? AND team_name_normalized = ?
                """,
                (competition_id, normalized_name),
            ).fetchone()

        if not row:
            return None

        competitor_id = str(row[0] or "").strip()
        return competitor_id or None
    except sqlite3.Error:
        return None


def upsert_sport_event_competitors(
    sport_event_id,
    competition_id,
    home_team,
    away_team,
    competitor_id,
    competitor2_id,
):
    if not sport_event_id:
        return

    updated_at = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO sport_event_competitors (
                sport_event_id,
                competition_id,
                home_team,
                away_team,
                competitor_id,
                competitor2_id,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(sport_event_id) DO UPDATE SET
                competition_id = excluded.competition_id,
                home_team = excluded.home_team,
                away_team = excluded.away_team,
                competitor_id = excluded.competitor_id,
                competitor2_id = excluded.competitor2_id,
                updated_at = excluded.updated_at
            """,
            (
                str(sport_event_id).strip(),
                str(competition_id or "").strip(),
                str(home_team or "").strip(),
                str(away_team or "").strip(),
                str(competitor_id or "").strip(),
                str(competitor2_id or "").strip(),
                updated_at,
            ),
        )
        conn.commit()


def get_sport_event_competitors(sport_event_id):
    if not sport_event_id:
        return None

    try:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute(
                """
                SELECT competition_id, home_team, away_team, competitor_id, competitor2_id
                FROM sport_event_competitors
                WHERE sport_event_id = ?
                """,
                (str(sport_event_id).strip(),),
            ).fetchone()

        if not row:
            return None

        return {
            "competition_id": str(row[0] or "").strip(),
            "home_team": str(row[1] or "").strip(),
            "away_team": str(row[2] or "").strip(),
            "competitor_id": str(row[3] or "").strip(),
            "competitor2_id": str(row[4] or "").strip(),
        }
    except sqlite3.Error:
        return None


def read_competition_catalog():
    try:
        with sqlite3.connect(DB_PATH) as conn:
            rows = conn.execute(
                """
                SELECT competition_id, competition_name
                FROM competition_catalog
                ORDER BY sort_order ASC, competition_name ASC
                """
            ).fetchall()

        return [
            {"id": str(row[0] or "").strip(), "name": str(row[1] or "").strip()}
            for row in rows
            if str(row[0] or "").strip() and str(row[1] or "").strip()
        ]
    except sqlite3.Error:
        return []


def _read_json_cache(table_name, key_column, key_value):
    if not str(key_value or "").strip():
        return None

    try:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute(
                f"SELECT payload FROM {table_name} WHERE {key_column} = ?",
                (str(key_value).strip(),),
            ).fetchone()

        if not row:
            return None

        return json.loads(row[0])
    except (sqlite3.Error, json.JSONDecodeError):
        return None


def _write_json_cache(table_name, key_column, key_value, payload):
    key_text = str(key_value or "").strip()
    if not key_text or payload is None:
        return

    updated_at = datetime.now(timezone.utc).isoformat()
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            f"""
            INSERT INTO {table_name} ({key_column}, payload, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT({key_column}) DO UPDATE SET
                payload = excluded.payload,
                updated_at = excluded.updated_at
            """,
            (key_text, json.dumps(payload), updated_at),
        )
        conn.commit()


def read_competition_seasons(competition_id):
    return _read_json_cache("competition_seasons_cache", "competition_id", competition_id)


def write_competition_seasons(competition_id, payload):
    _write_json_cache("competition_seasons_cache", "competition_id", competition_id, payload)


def read_season_standings(season_id):
    return _read_json_cache("season_standings_cache", "season_id", season_id)


def write_season_standings(season_id, payload):
    _write_json_cache("season_standings_cache", "season_id", season_id, payload)


def read_timeline(sport_event_id):
    return _read_json_cache("sport_event_timeline_cache", "sport_event_id", sport_event_id)


def write_timeline(sport_event_id, payload):
    _write_json_cache("sport_event_timeline_cache", "sport_event_id", sport_event_id, payload)


def read_starting_lineups(sport_event_id):
    return _read_json_cache("sport_event_starting_lineups_cache", "sport_event_id", sport_event_id)


def write_starting_lineups(sport_event_id, payload):
    _write_json_cache("sport_event_starting_lineups_cache", "sport_event_id", sport_event_id, payload)


def read_team_roster(competitor_id):
    return _read_json_cache("team_roster_cache", "competitor_id", competitor_id)


def write_team_roster(competitor_id, payload):
    _write_json_cache("team_roster_cache", "competitor_id", competitor_id, payload)


def get_user_favorite_league(user_id):
    user_id_text = str(user_id or "").strip()
    if not user_id_text:
        return ""

    try:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute(
                """
                SELECT competition_id
                FROM user_favorite_leagues
                WHERE user_id = ?
                LIMIT 1
                """,
                (user_id_text,),
            ).fetchone()

        if not row:
            return ""

        return str(row[0] or "").strip()
    except sqlite3.Error:
        return ""


def set_user_favorite_league(user_id, competition_id):
    user_id_text = str(user_id or "").strip()
    competition_id_text = str(competition_id or "").strip()
    if not user_id_text or not competition_id_text:
        return False

    updated_at = datetime.now(timezone.utc).isoformat()
    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute(
                """
                INSERT INTO user_favorite_leagues (user_id, competition_id, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    competition_id = excluded.competition_id,
                    updated_at = excluded.updated_at
                """,
                (user_id_text, competition_id_text, updated_at),
            )
            conn.commit()
        return True
    except sqlite3.Error:
        return False


def clear_user_favorite_league(user_id):
    user_id_text = str(user_id or "").strip()
    if not user_id_text:
        return False

    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute(
                "DELETE FROM user_favorite_leagues WHERE user_id = ?",
                (user_id_text,),
            )
            conn.commit()
        return True
    except sqlite3.Error:
        return False


def _format_chat_preview(home_team, away_team, start_time):
    home = str(home_team or "Team").strip() or "Team"
    away = str(away_team or "Team").strip() or "Team"

    date_text = "--/--/----"
    start_time_raw = str(start_time or "").strip()
    if start_time_raw:
        try:
            parsed = datetime.fromisoformat(start_time_raw.replace("Z", "+00:00"))
            date_text = parsed.strftime("%m/%d/%Y")
        except ValueError:
            pass

    return f"{home} vs {away} {date_text}"


def _upsert_chat_conversation(user_id, sport_event_id, home_team, away_team, start_time):
    user_id_text = str(user_id or "").strip()
    event_id_text = str(sport_event_id or "").strip()
    if not user_id_text or not event_id_text:
        return None

    home = str(home_team or "").strip()
    away = str(away_team or "").strip()
    kickoff = str(start_time or "").strip()
    preview = _format_chat_preview(home, away, kickoff)
    now = datetime.now(timezone.utc).isoformat()

    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute(
                """
                INSERT INTO chat_conversations (
                    user_id,
                    sport_event_id,
                    home_team,
                    away_team,
                    start_time,
                    preview_title,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(user_id, sport_event_id) DO UPDATE SET
                    home_team = CASE
                        WHEN excluded.home_team != '' THEN excluded.home_team
                        ELSE chat_conversations.home_team
                    END,
                    away_team = CASE
                        WHEN excluded.away_team != '' THEN excluded.away_team
                        ELSE chat_conversations.away_team
                    END,
                    start_time = CASE
                        WHEN excluded.start_time != '' THEN excluded.start_time
                        ELSE chat_conversations.start_time
                    END,
                    preview_title = CASE
                        WHEN excluded.preview_title IS NOT NULL AND excluded.preview_title != '' THEN excluded.preview_title
                        ELSE chat_conversations.preview_title
                    END,
                    updated_at = excluded.updated_at
                """,
                (user_id_text, event_id_text, home, away, kickoff, preview, now, now),
            )

            row = conn.execute(
                """
                SELECT id
                FROM chat_conversations
                WHERE user_id = ? AND sport_event_id = ?
                """,
                (user_id_text, event_id_text),
            ).fetchone()

            conn.commit()
        return int(row[0]) if row else None
    except sqlite3.Error:
        return None


def save_chat_message(user_id, sport_event_id, role, content, home_team="", away_team="", start_time=""):
    role_text = str(role or "").strip().lower()
    content_text = str(content or "").strip()
    if role_text not in {"user", "assistant"} or not content_text:
        return False

    conversation_id = _upsert_chat_conversation(user_id, sport_event_id, home_team, away_team, start_time)
    if not conversation_id:
        return False

    now = datetime.now(timezone.utc).isoformat()
    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute(
                """
                INSERT INTO chat_messages (conversation_id, role, content, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (conversation_id, role_text, content_text, now),
            )
            conn.execute(
                """
                UPDATE chat_conversations
                SET updated_at = ?,
                    preview_title = ?
                WHERE id = ?
                """,
                (
                    now,
                    _format_chat_preview(home_team, away_team, start_time),
                    conversation_id,
                ),
            )
            conn.commit()
        return True
    except sqlite3.Error:
        return False


def get_chat_conversations_for_user(user_id):
    user_id_text = str(user_id or "").strip()
    if not user_id_text:
        return []

    try:
        with sqlite3.connect(DB_PATH) as conn:
            rows = conn.execute(
                """
                SELECT sport_event_id, home_team, away_team, start_time, preview_title, updated_at
                FROM chat_conversations
                WHERE user_id = ?
                ORDER BY updated_at DESC
                """,
                (user_id_text,),
            ).fetchall()

        return [
            {
                "sport_event_id": str(row[0] or "").strip(),
                "home_team": str(row[1] or "").strip(),
                "away_team": str(row[2] or "").strip(),
                "start_time": str(row[3] or "").strip(),
                "preview": str(row[4] or "").strip(),
                "updated_at": str(row[5] or "").strip(),
            }
            for row in rows
            if str(row[0] or "").strip()
        ]
    except sqlite3.Error:
        return []


def get_chat_messages_for_user_game(user_id, sport_event_id):
    user_id_text = str(user_id or "").strip()
    event_id_text = str(sport_event_id or "").strip()
    if not user_id_text or not event_id_text:
        return []

    try:
        with sqlite3.connect(DB_PATH) as conn:
            rows = conn.execute(
                """
                SELECT m.role, m.content, m.created_at
                FROM chat_messages m
                INNER JOIN chat_conversations c ON c.id = m.conversation_id
                WHERE c.user_id = ? AND c.sport_event_id = ?
                ORDER BY m.created_at ASC, m.id ASC
                """,
                (user_id_text, event_id_text),
            ).fetchall()

        return [
            {
                "role": str(row[0] or "").strip(),
                "content": str(row[1] or "").strip(),
                "created_at": str(row[2] or "").strip(),
            }
            for row in rows
            if str(row[1] or "").strip()
        ]
    except sqlite3.Error:
        return []


def get_chat_conversation_for_user_game(user_id, sport_event_id):
    user_id_text = str(user_id or "").strip()
    event_id_text = str(sport_event_id or "").strip()
    if not user_id_text or not event_id_text:
        return None

    try:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute(
                """
                SELECT sport_event_id, home_team, away_team, start_time, preview_title, updated_at
                FROM chat_conversations
                WHERE user_id = ? AND sport_event_id = ?
                LIMIT 1
                """,
                (user_id_text, event_id_text),
            ).fetchone()

        if not row:
            return None

        return {
            "sport_event_id": str(row[0] or "").strip(),
            "home_team": str(row[1] or "").strip(),
            "away_team": str(row[2] or "").strip(),
            "start_time": str(row[3] or "").strip(),
            "preview": str(row[4] or "").strip(),
            "updated_at": str(row[5] or "").strip(),
        }
    except sqlite3.Error:
        return None


def delete_chat_conversation_for_user_game(user_id, sport_event_id):
    user_id_text = str(user_id or "").strip()
    event_id_text = str(sport_event_id or "").strip()
    if not user_id_text or not event_id_text:
        return False

    try:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute(
                """
                SELECT id
                FROM chat_conversations
                WHERE user_id = ? AND sport_event_id = ?
                LIMIT 1
                """,
                (user_id_text, event_id_text),
            ).fetchone()

            if not row:
                return False

            conversation_id = int(row[0])
            conn.execute(
                "DELETE FROM chat_messages WHERE conversation_id = ?",
                (conversation_id,),
            )
            conn.execute(
                "DELETE FROM chat_conversations WHERE id = ?",
                (conversation_id,),
            )
            conn.commit()
        return True
    except sqlite3.Error:
        return False


def clear_chat_history_for_user(user_id):
    user_id_text = str(user_id or "").strip()
    if not user_id_text:
        return False

    try:
        with sqlite3.connect(DB_PATH) as conn:
            conversation_rows = conn.execute(
                "SELECT id FROM chat_conversations WHERE user_id = ?",
                (user_id_text,),
            ).fetchall()

            conversation_ids = [int(row[0]) for row in conversation_rows if row and row[0] is not None]

            if conversation_ids:
                placeholders = ",".join(["?"] * len(conversation_ids))
                conn.execute(
                    f"DELETE FROM chat_messages WHERE conversation_id IN ({placeholders})",
                    tuple(conversation_ids),
                )

            conn.execute(
                "DELETE FROM chat_conversations WHERE user_id = ?",
                (user_id_text,),
            )
            conn.commit()
        return True
    except sqlite3.Error:
        return False
