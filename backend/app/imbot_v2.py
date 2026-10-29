"""Bitrix24 chatbot calls through an incoming webhook and imbot.v2.

The webhook URL and botToken stay on the server. Errors returned to the panel
contain the Bitrix error code, not the webhook.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlsplit

import httpx

BOT_TOKEN_MAX = 40
BOT_TYPES = frozenset({"bot", "supervisor", "personal"})
BOT_COLORS = frozenset(
    {
        "GREEN",
        "RED",
        "MINT",
        "LIGHT_BLUE",
        "DARK_BLUE",
        "PURPLE",
        "AQUA",
        "PINK",
        "LIME",
        "BROWN",
        "AZURE",
        "GRAY",
    }
)
BACKGROUNDS = frozenset(
    {"azure", "mint", "steel", "slate", "teal", "cornflower", "sky", "peach", "frost"}
)
EVENT_MODES = frozenset({"fetch", "webhook"})
_CODE_MAX = 64
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class ImbotError(Exception):
    def __init__(self, code: str, description: str = "") -> None:
        self.code = (code or "BITRIX_ERROR")[:80]
        self.description = (description or "")[:300]
        super().__init__(self.code if not self.description else f"{self.code}: {self.description}")


def webhook_base(value: str) -> str:
    text = (value or "").strip()
    if not text:
        raise ImbotError("WEBHOOK_REQUIRED", "Укажите входящий вебхук")
    if not text.endswith("/"):
        text += "/"
    parts = urlsplit(text)
    if parts.scheme not in {"http", "https"} or not parts.netloc:
        raise ImbotError("WEBHOOK_INVALID", "Вебхук должен быть http(s) URL")
    if parts.username or parts.password or " " in text:
        raise ImbotError("WEBHOOK_INVALID", "В адресе вебхука не должно быть логина и пробелов")
    rest = parts.path or ""
    if "/rest/" not in rest:
        raise ImbotError("WEBHOOK_INVALID", "Это не входящий вебхук Bitrix24")
    return f"{parts.scheme}://{parts.netloc}{rest}"


def webhook_host(value: str) -> str:
    try:
        base = webhook_base(value)
    except ImbotError:
        return ""
    return urlsplit(base).netloc


def clean_token(value: str, *, required: bool) -> str:
    token = (value or "").strip()
    if not token:
        if required:
            raise ImbotError("BOT_TOKEN_REQUIRED", "Укажите botToken")
        return ""
    if len(token) > BOT_TOKEN_MAX or any(ch.isspace() for ch in token):
        raise ImbotError("BOT_TOKEN_INVALID_LENGTH", "botToken не длиннее 40 символов и без пробелов")
    return token


def clean_code(value: str) -> str:
    """Unique bot code for imbot.v2.Bot.register.

    Bitrix requires the field and treats the same code as the same bot.
    It does not publish a character class, so a hyphen or a short code from
    an existing script is kept. Spaces become underscores.
    """
    code = re.sub(r"\s+", "_", (value or "").strip())
    if not code:
        raise ImbotError(
            "BOT_CODE_REQUIRED",
            "Код бота пустой. Оставьте поле пустым — Corax задаст его сам.",
        )
    if len(code) > _CODE_MAX:
        raise ImbotError("BOT_CODE_INVALID", "Код бота не длиннее 64 символов")
    return code


def clean_email(value: str | None) -> str:
    """Bot mailbox. Empty is allowed. A real employee's address must not be reused."""
    text = (value or "").strip()
    if not text:
        return ""
    if len(text) > 255 or _EMAIL_RE.match(text) is None:
        raise ImbotError("BOT_EMAIL_INVALID", "Почта бота: name@domain. Не используйте почту живого сотрудника.")
    return text


def legacy_email_body(bot_id: int, email: str) -> dict[str, Any]:
    """imbot.update is the call that still writes PROPERTIES.EMAIL. v2 ignores it."""
    return {"BOT_ID": int(bot_id), "FIELDS": {"PROPERTIES": {"EMAIL": email}}}


def avatar_base64(value: str | None) -> str | None:
    raw = (value or "").strip()
    if not raw:
        return None
    if raw.startswith("data:") and "," in raw:
        raw = raw.split(",", 1)[1]
    raw = "".join(raw.split())
    if len(raw) > 2_000_000:
        raise ImbotError("BOT_AVATAR_INCORRECT_SIZE", "Аватар слишком большой")
    return raw or None


def profile_properties(fields: dict[str, Any]) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    name = str(fields.get("name") or "").strip()
    last = str(fields.get("last_name") or "").strip()
    position = str(fields.get("position") or "").strip()
    color = str(fields.get("color") or "").strip().upper()
    gender = str(fields.get("gender") or "").strip().upper()
    if name:
        properties["name"] = name[:128]
    if last:
        properties["lastName"] = last[:128]
    if position:
        properties["workPosition"] = position[:128]
    if color:
        if color not in BOT_COLORS:
            raise ImbotError("BOT_COLOR_INVALID", "Такого цвета аватара нет")
        properties["color"] = color
    if gender:
        if gender not in {"M", "F"}:
            raise ImbotError("BOT_GENDER_INVALID", "Пол: M или F")
        properties["gender"] = gender
    photo = avatar_base64(fields.get("avatar_base64") if isinstance(fields.get("avatar_base64"), str) else None)
    if photo:
        properties["avatar"] = photo
    return properties


def profile_update_fields(fields: dict[str, Any]) -> dict[str, Any]:
    """Fields for imbot.v2.Bot.update when the admin edits the profile.

    Name, last name and position always go out. An empty last name is an
    empty string: since imbot 26.500 a missing key is left unchanged, and
    null is ignored. eventMode and type stay out of this call — a bad
    handler URL or an unknown key makes Bitrix reject the whole update,
    so the new name never lands.
    """
    out = appearance_fields(fields)
    properties = profile_properties(fields)
    properties["lastName"] = str(fields.get("last_name") or "").strip()[:128]
    properties["workPosition"] = str(fields.get("position") or "").strip()[:128]
    if properties:
        out["properties"] = properties
    return out


def clean_event_mode(value: str | None, *, default: str = "fetch") -> str:
    mode = (value or "").strip().lower()
    if mode in EVENT_MODES:
        return mode
    if not mode:
        return default
    raise ImbotError("BOT_EVENT_MODE_INVALID", "Режим: fetch или webhook")


def delivery_fields(event_mode: str | None, webhook_url: str | None = None) -> dict[str, Any]:
    """eventMode for imbot.v2.Bot.register and Bot.update. Empty input is left unset."""
    mode = (event_mode or "").strip().lower()
    if not mode:
        return {}
    mode = clean_event_mode(mode)
    out: dict[str, Any] = {"eventMode": mode}
    if mode == "webhook" and (webhook_url or "").strip():
        out["webhookUrl"] = webhook_url.strip()
    return out


def appearance_fields(fields: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if "hidden" in fields and fields["hidden"] is not None:
        out["isHidden"] = bool(fields["hidden"])
    if "reactions" in fields and fields["reactions"] is not None:
        out["isReactionsEnabled"] = bool(fields["reactions"])
    if "openline" in fields and fields["openline"] is not None:
        out["isSupportOpenline"] = bool(fields["openline"])
    if "background_id" not in fields or fields.get("background_id") is None:
        return out
    text = str(fields.get("background_id") or "").strip()
    if not text or text == "default":
        out["backgroundId"] = None
    elif text not in BACKGROUNDS:
        raise ImbotError("BOT_BACKGROUND_INVALID", "Такого фона чата нет")
    else:
        out["backgroundId"] = text
    return out


def _first(*values: Any) -> str:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


_LEGACY_EVENTS = {
    "ONIMBOTMESSAGEADD": "ONIMBOTV2MESSAGEADD",
    "ONIMBOTJOINCHAT": "ONIMBOTV2JOINCHAT",
    "ONIMJOINCHAT": "ONIMBOTV2JOINCHAT",
    "ONIMCOMMANDADD": "ONIMBOTV2COMMANDADD",
}
_JSON_RETRY = frozenset({"ERROR_METHOD_NOT_FOUND", "BITRIX_HTTP", "BITRIX_BAD_RESPONSE"})


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _ci(obj: Any, *names: str) -> Any:
    if not isinstance(obj, dict):
        return None
    folded = {str(key).lower(): item for key, item in obj.items()}
    for name in names:
        if name.lower() in folded:
            return folded[name.lower()]
    return None


def parse_v2_event(payload: dict[str, Any]) -> dict[str, str] | None:
    """Fields Corax needs from an imbot.v2 body or the older ONIMBOT* form.

    A private chat is answered at the user id. A group chat is answered at
    chat.dialogId, which Bitrix sends as chat{id}. None for unrelated events.
    """
    raw_event = _first(payload.get("event"), payload.get("EVENT")).upper()
    if raw_event.startswith("ONIMBOTV2"):
        event = raw_event
    elif raw_event in _LEGACY_EVENTS:
        event = _LEGACY_EVENTS[raw_event]
    else:
        return None
    data = _as_dict(payload.get("data") or payload.get("DATA"))
    params = _as_dict(_ci(data, "params"))
    bot = _as_dict(_ci(data, "bot"))
    message = _as_dict(_ci(data, "message"))
    chat = _as_dict(_ci(data, "chat"))
    user = _as_dict(_ci(data, "user"))
    command = _as_dict(_ci(data, "command"))
    dialog = _first(
        _ci(chat, "dialogId", "dialog_id"),
        _ci(data, "dialogId", "dialog_id"),
        _ci(params, "DIALOG_ID", "DIALOGID"),
    )
    chat_id = _first(_ci(chat, "id"), _ci(params, "CHAT_ID", "CHATID"))
    user_id = _first(
        _ci(user, "id"),
        _ci(message, "authorId"),
        _ci(params, "FROM_USER_ID", "AUTHOR_ID", "USER_ID"),
    )
    if not dialog:
        dialog = user_id or (f"chat{chat_id}" if chat_id else "")
    bot_flag = _ci(user, "bot")
    from_bot = str(bot_flag).strip().lower() in {"1", "true", "y"}
    return {
        "event": event,
        "bot_id": _first(_ci(bot, "id", "bot_id"), _ci(params, "BOT_ID")),
        "text": _first(_ci(message, "text", "message"), _ci(params, "MESSAGE", "MESSAGE_TEXT", "TEXT")),
        "dialog_id": dialog,
        "user_id": user_id,
        "user_name": _first(
            _ci(user, "name", "firstName"),
            _ci(params, "FROM_USER_NAME", "AUTHOR_NAME"),
        ),
        "message_id": _first(_ci(message, "id", "messageId"), _ci(params, "MESSAGE_ID", "ID")),
        "chat_id": chat_id,
        "from_bot": "1" if from_bot else "0",
        "command": _first(_ci(command, "command"), _ci(params, "COMMAND")).lstrip("/"),
        "command_context": _first(_ci(command, "context")),
    }


def parse_fetch_event(event: dict[str, Any]) -> dict[str, str] | None:
    """One item from imbot.v2.Event.get. The working bot reads type and data."""
    if not isinstance(event, dict):
        return None
    kind = event.get("type") or event.get("event") or ""
    data = event.get("data") if isinstance(event.get("data"), dict) else {}
    return parse_v2_event({"event": str(kind), "data": data})


def dialog_candidates(event: dict[str, str]) -> list[str]:
    """dialogId first, then the user id, then chat{id}. The first one Bitrix accepts wins."""
    seen: list[str] = []

    def add(value: str) -> None:
        text = (value or "").strip()
        if text and text not in seen:
            seen.append(text)

    add(event.get("dialog_id") or "")
    add(event.get("user_id") or "")
    chat_id = (event.get("chat_id") or "").strip()
    if chat_id.isdigit():
        add("chat" + chat_id)
    dialog = (event.get("dialog_id") or "").strip()
    if dialog.isdigit():
        add("chat" + dialog)
    return seen


async def call(webhook: str, method: str, body: dict[str, Any]) -> dict[str, Any]:
    try:
        return await _post_json(webhook, method, body)
    except ImbotError as exc:
        if method.endswith(".json") or exc.code not in _JSON_RETRY:
            raise
        return await _post_json(webhook, f"{method}.json", body)


async def _post_json(webhook: str, method: str, body: dict[str, Any]) -> dict[str, Any]:
    base = webhook_base(webhook)
    url = base + method
    timeout = httpx.Timeout(30.0, connect=10.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(url, json=body, headers={"Accept": "application/json"})
    except httpx.HTTPError as exc:
        raise ImbotError("BITRIX_UNREACHABLE", exc.__class__.__name__) from exc
    try:
        data = response.json()
    except Exception as exc:
        raise ImbotError("BITRIX_BAD_RESPONSE", f"HTTP {response.status_code}") from exc
    if not isinstance(data, dict):
        raise ImbotError("BITRIX_BAD_RESPONSE", f"HTTP {response.status_code}")
    if data.get("error"):
        raise ImbotError(str(data.get("error")), str(data.get("error_description") or ""))
    if response.status_code >= 400:
        raise ImbotError("BITRIX_HTTP", f"HTTP {response.status_code}")
    result = data.get("result")
    return result if isinstance(result, dict) else {"result": result}


def public_card(result: dict[str, Any]) -> dict[str, Any]:
    bot = result.get("bot") if isinstance(result.get("bot"), dict) else {}
    users = result.get("users") if isinstance(result.get("users"), list) else []
    user = next((item for item in users if isinstance(item, dict)), {})
    return {
        "bot_id": bot.get("id"),
        "code": bot.get("code") or "",
        "bot_type": bot.get("type") or "",
        "event_mode": bot.get("eventMode") or "",
        "name": user.get("firstName") or user.get("name") or "",
        "last_name": user.get("lastName") or "",
        "position": user.get("workPosition") or "",
        "email": user.get("email") or "",
        "color": user.get("color") or "",
        "gender": user.get("gender") if user.get("gender") in {"M", "F"} else "",
        "hidden": bool(bot.get("isHidden")),
        "reactions": bot.get("isReactionsEnabled") if "isReactionsEnabled" in bot else None,
        "openline": bot.get("isSupportOpenline") if "isSupportOpenline" in bot else None,
        "background_id": bot.get("backgroundId") or "",
    }


def _count(value: Any) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def public_bots(result: dict[str, Any]) -> list[dict[str, Any]]:
    """Rows from imbot.v2.Bot.list. Tokens are not part of that response."""
    bots = result.get("bots") if isinstance(result.get("bots"), list) else []
    users = result.get("users") if isinstance(result.get("users"), list) else []
    by_id = {
        item.get("id"): item
        for item in users
        if isinstance(item, dict) and item.get("id") is not None
    }
    rows: list[dict[str, Any]] = []
    for bot in bots:
        if not isinstance(bot, dict) or bot.get("id") is None:
            continue
        user = by_id.get(bot.get("id"), {})
        gender = user.get("gender") if user.get("gender") in {"M", "F"} else ""
        rows.append(
            {
                "bot_id": int(bot["id"]),
                "code": str(bot.get("code") or ""),
                "bot_type": str(bot.get("type") or ""),
                "name": str(user.get("name") or user.get("firstName") or ""),
                "last_name": str(user.get("lastName") or ""),
                "position": str(user.get("workPosition") or ""),
                "email": str(user.get("email") or ""),
                "color": str(user.get("color") or ""),
                "gender": gender,
                "event_mode": str(bot.get("eventMode") or ""),
                "background_id": str(bot.get("backgroundId") or ""),
                "hidden": bool(bot.get("isHidden")),
                "reactions": bool(bot.get("isReactionsEnabled")) if "isReactionsEnabled" in bot else True,
                "openline": bool(bot.get("isSupportOpenline")),
                "count_message": _count(bot.get("countMessage")),
                "count_command": _count(bot.get("countCommand")),
                "count_chat": _count(bot.get("countChat")),
                "count_user": _count(bot.get("countUser")),
            }
        )
    return rows


def keyboard_sig(keyboard: list[dict[str, str]] | None) -> str:
    """Stable label list. The same signature means the chat already shows these buttons."""
    if not keyboard:
        return ""
    return "|".join(str(button.get("TEXT") or "").strip() for button in keyboard)


def attach_keyboard(
    previous_sig: str, keyboard: list[dict[str, str]] | None
) -> list[dict[str, str]] | None:
    """Put the buttons on this message. The caller clears the previous keyboard first."""
    del previous_sig
    if not keyboard_sig(keyboard):
        return None
    return keyboard


MENU_COMMANDS = (
    ("ticket", "Оставить заявку", "New ticket"),
    ("status", "Мои заявки", "My tickets"),
    ("help", "Помощь", "Help"),
    ("pc", "Мой компьютер", "My computer"),
    ("stock", "Склад", "Warehouse"),
    ("sla", "Срок заявки", "Ticket due"),
)


def command_register_body(bot_id: int, token: str, command: str, ru: str, en: str) -> dict[str, Any]:
    """Visible slash command. Bitrix shows the Russian title in the chat + menu."""
    return {
        "botId": int(bot_id),
        "botToken": token,
        "fields": {
            "command": command,
            "title": {"ru": ru, "en": en},
            "common": False,
            "hidden": False,
        },
    }


def send_keyboard(*labels: str) -> list[dict[str, str]]:
    """Buttons that send their caption as a normal chat message. Same shape as the working bot."""
    buttons: list[dict[str, str]] = []
    for label in labels:
        title = (label or "").strip()
        if not title:
            continue
        primary = not buttons
        buttons.append(
            {
                "TEXT": title,
                "ACTION": "SEND",
                "ACTION_VALUE": title,
                "BG_COLOR_TOKEN": "primary" if primary else "secondary",
                "DISPLAY": "LINE",
            }
        )
    return buttons
