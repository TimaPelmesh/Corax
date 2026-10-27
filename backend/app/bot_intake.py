"""Chat steps and the phrases the Bitrix bot says.

Buttons send their caption as a normal message. A ticket opens only from the
text that follows «Оставить заявку», and its number is the Corax id.
Greetings follow the server's local clock, wherever Corax is installed.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone

LEAVE = "Оставить заявку"
MINE = "Мои заявки"
STATUS = "Статус заявки"
HELP = "Помощь"
CANCEL = "Отмена"
TICKET_COMMAND = "corax_ticket"
_SLASH = {
    "ticket": "ask",
    "corax_ticket": "ask",
    "status": "status",
    "help": "help",
    "cancel": "cancel",
}

OFF = "Приём заявок сейчас выключен."
NO_TICKET = "Заявок от вас пока нет. Нажмите на кнопку ниже, чтобы создать первую."
# The same sentences are shown in the bot panel, already typed into the fields.
DEFAULT_LINES = {
    "greet_body": "Я рядом и с радостью приму заявку.",
    "greet_tail": "Нажмите на кнопку ниже.",
    "ask": (
        "Напишите, пожалуйста, одним сообщением, что нужно сделать: "
        "что заменить, исправить или что случилось. Я сразу заведу заявку."
    ),
    "cancel": "Хорошо! Буду ждать вас снова тут.",
    "accepted": "Спасибо. 📝 Заявка №{id} принята.",
    "closed": (
        "{mark} Заявка №{id} {verb}.\n"
        "Спасибо, что обратились.{wish}\n"
        "Если понадобится ещё помощь — нажмите на кнопку ниже."
    ),
    "help": "Нажмите на кнопку ниже.",
    "nudge": "{hello}\nНажмите на кнопку ниже.",
    "off": OFF,
    "no_ticket": NO_TICKET,
    "status": "{mark} Заявка №{id} — {label}.",
}
BITRIX_MARK = "[Битрикс]"
_STATE = {
    "open": ("📝", "принята"),
    "in_progress": ("🔧", "в работе"),
    "done": ("✅", "выполнена"),
    "cancelled": ("", "отменена"),
}


@dataclass(frozen=True)
class BotVoice:
    greet_name: bool = True
    greet_daypart: bool = True
    greeting_note: str = ""
    close_notice: bool = True
    greet_body: str = ""
    greet_tail: str = ""
    ask: str = ""
    cancel: str = ""
    accepted: str = ""
    closed: str = ""
    help: str = ""
    nudge: str = ""
    off: str = ""
    no_ticket: str = ""
    status: str = ""


_NOTE_LIMIT = 400
_TEXT_LIMIT = 800
_PHRASE_TEXT = (
    "greeting_note",
    "greet_body",
    "greet_tail",
    "ask",
    "cancel",
    "accepted",
    "closed",
    "help",
    "nudge",
    "off",
    "no_ticket",
    "status",
)


def _pick(custom: str, default: str) -> str:
    text = (custom or "").strip()
    return text or default


def fill_phrase(template: str, **values: object) -> str:
    """Replace {id} and {name}. Unknown braces stay so a typo is visible."""

    def repl(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in values:
            return match.group(0)
        return str(values[key])

    return re.sub(r"\{([a-z_]+)\}", repl, template)


def normalize_phrases(raw: dict) -> dict:
    """Drop empty lines. False flags are kept; True matches the built-in default."""
    if not isinstance(raw, dict):
        return {}
    out: dict = {}
    for key in ("greet_daypart", "close_notice"):
        if key in raw and raw[key] is not None:
            flag = bool(raw[key])
            if not flag:
                out[key] = False
    for key in _PHRASE_TEXT:
        if key not in raw or raw[key] is None:
            continue
        limit = _NOTE_LIMIT if key == "greeting_note" else _TEXT_LIMIT
        text = str(raw[key]).strip()[:limit]
        if text:
            out[key] = text
    return out


def parse_scripts(raw: str | None) -> dict[str, dict]:
    """Phrases saved per Bitrix bot id. The active bot is the one Corax answers as."""
    try:
        loaded = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return {}
    if not isinstance(loaded, dict):
        return {}
    scripts: dict[str, dict] = {}
    for key, value in loaded.items():
        if not str(key).isdigit() or not isinstance(value, dict):
            continue
        number = str(int(key))
        if number == "0":
            continue
        clean = normalize_phrases(value)
        if clean:
            scripts[number] = clean
    return scripts


def dump_scripts(scripts: dict) -> str:
    return json.dumps(parse_scripts(json.dumps(scripts)), ensure_ascii=False)


def phrases_for_bot(
    raw: str | None,
    bot_id: int | None,
    *,
    greet_daypart: bool,
    greeting_note: str,
    close_notice: bool,
) -> dict:
    """Stored lines for this id, or the older single set while it still belongs to this bot."""
    scripts = parse_scripts(raw)
    if not bot_id:
        return {}
    key = str(int(bot_id))
    if key in scripts:
        return scripts[key]
    return normalize_phrases(
        {
            "greet_daypart": greet_daypart,
            "close_notice": close_notice,
            "greeting_note": greeting_note,
        }
    )


def voice_from_phrases(phrases: dict | None) -> BotVoice:
    data = phrases or {}
    by_time = data.get("greet_daypart", True) is not False
    return BotVoice(
        greet_name=by_time,
        greet_daypart=by_time,
        greeting_note=str(data.get("greeting_note") or ""),
        close_notice=data.get("close_notice", True) is not False,
        greet_body=str(data.get("greet_body") or ""),
        greet_tail=str(data.get("greet_tail") or ""),
        ask=str(data.get("ask") or ""),
        cancel=str(data.get("cancel") or ""),
        accepted=str(data.get("accepted") or ""),
        closed=str(data.get("closed") or ""),
        help=str(data.get("help") or ""),
        nudge=str(data.get("nudge") or ""),
        off=str(data.get("off") or ""),
        no_ticket=str(data.get("no_ticket") or ""),
        status=str(data.get("status") or ""),
    )


def normalize_command(value: str) -> str:
    return (value or "").strip().lstrip("/").lower()


def _norm(value: str) -> str:
    text = re.sub(r"\[[^\]]*\]", " ", value or "")
    text = text.replace("ё", "е").casefold()
    text = re.sub(r"[^\w\s]+", " ", text, flags=re.UNICODE)
    return " ".join(text.split())


def button_kind(text: str, command: str = "") -> str | None:
    """Which menu button this message is, after Bitrix trims or wraps the caption."""
    raw = _norm(text)
    cmd = _norm(command)
    pairs = (
        ("ask", (LEAVE,)),
        ("cancel", (CANCEL,)),
        ("status", (MINE, "Моя заявка", STATUS)),
        ("help", (HELP,)),
    )
    for kind, labels in pairs:
        for label in labels:
            token = _norm(label)
            if raw == token or cmd == token:
                return kind
    return None


def bitrix_title(text: str) -> str:
    head = (text or "").strip().splitlines()[0].strip() or "Заявка"
    if not head.casefold().startswith("[битрикс]"):
        head = f"{BITRIX_MARK} {head}"
    if len(head) > 255:
        head = head[:252] + "..."
    return head


def given_name(name: str) -> str:
    return ((name or "").strip().split() or [""])[0][:40]


def _local(moment: datetime | None) -> datetime:
    """A supplied moment keeps its own zone. A live greeting uses the server clock."""
    if moment is None:
        return datetime.now().astimezone()
    if moment.tzinfo is None:
        return moment.replace(tzinfo=timezone.utc)
    return moment


def daypart(moment: datetime | None = None) -> str:
    hour = _local(moment).hour
    if 5 <= hour < 12:
        return "Доброе утро"
    if 12 <= hour < 17:
        return "Добрый день"
    if 17 <= hour < 23:
        return "Добрый вечер"
    return "Доброй ночи"


def farewell(moment: datetime | None = None) -> str:
    hour = _local(moment).hour
    if 5 <= hour < 12:
        return "Хорошего утра"
    if 12 <= hour < 17:
        return "Хорошего дня"
    if 17 <= hour < 23:
        return "Хорошего вечера"
    return "Доброй ночи"


def hello(name: str, voice: BotVoice, moment: datetime | None = None) -> str:
    """The name is spoken only inside the time-of-day wish."""
    if not voice.greet_daypart:
        return "Здравствуйте!"
    who = given_name(name)
    lead = daypart(moment)
    if who:
        return f"{lead}, {who}!"
    return f"{lead}!"


def greeting_text(name: str, voice: BotVoice, moment: datetime | None = None) -> str:
    lines = [
        hello(name, voice, moment),
        _pick(voice.greet_body, DEFAULT_LINES["greet_body"]),
    ]
    note = (voice.greeting_note or "").strip()
    if note:
        lines.append(note)
    lines.append(_pick(voice.greet_tail, DEFAULT_LINES["greet_tail"]))
    return "\n".join(lines)


def ask_text(name: str, voice: BotVoice) -> str:
    del name
    return _pick(voice.ask, DEFAULT_LINES["ask"])


def nudge_text(name: str, voice: BotVoice, moment: datetime | None = None) -> str:
    hi = hello(name, voice, moment)
    return fill_phrase(_pick(voice.nudge, DEFAULT_LINES["nudge"]), hello=hi, name=given_name(name))


def cancel_text(name: str, voice: BotVoice) -> str:
    del name
    return _pick(voice.cancel, DEFAULT_LINES["cancel"])


def help_text(voice: BotVoice) -> str:
    return _pick(voice.help, DEFAULT_LINES["help"])


def off_text(voice: BotVoice) -> str:
    return _pick(voice.off, OFF)


def accepted_text(
    ticket_id: int,
    text: str = "",
    *,
    name: str = "",
    voice: BotVoice | None = None,
) -> str:
    del text
    tone = voice or BotVoice()
    return fill_phrase(
        _pick(tone.accepted, DEFAULT_LINES["accepted"]),
        id=ticket_id,
        name=given_name(name),
    )


def closed_text(
    ticket_id: int,
    *,
    name: str = "",
    status: str = "done",
    voice: BotVoice | None = None,
    moment: datetime | None = None,
) -> str:
    tone = voice or BotVoice()
    who = given_name(name) if tone.greet_daypart else ""
    mark, verb = _STATE["cancelled"] if (status or "").strip() == "cancelled" else _STATE["done"]
    wish = f" {farewell(moment)}, {who}!" if who else f" {farewell(moment)}!" if tone.greet_daypart else ""
    return fill_phrase(
        _pick(tone.closed, DEFAULT_LINES["closed"]),
        id=ticket_id,
        name=who,
        wish=wish,
        mark=mark,
        verb=verb,
        farewell=farewell(moment) if tone.greet_daypart else "",
    )


def status_text(
    ticket_id: int | None,
    text: str = "",
    *,
    state: str = "",
    voice: BotVoice | None = None,
) -> str:
    tone = voice or BotVoice()
    if not ticket_id:
        return _pick(tone.no_ticket, DEFAULT_LINES["no_ticket"])
    mark, label = _STATE.get((state or "").strip(), _STATE["open"])
    body = (text or "").strip()
    custom = _pick(tone.status, DEFAULT_LINES["status"])
    head = fill_phrase(custom, id=ticket_id, mark=mark, label=label, title=body)
    if body and "{title}" not in custom:
        return f"{head}\n{body}" if head else body
    return head


def intake_step(event: str, command: str, text: str, *, enabled: bool, waiting: bool) -> str:
    """greet, ask, take, status, help, cancel, nudge, off, or skip."""
    kind = (event or "").strip()
    if kind not in {"ONIMBOTV2JOINCHAT", "ONIMBOTV2MESSAGEADD", "ONIMBOTV2COMMANDADD"}:
        return "skip"
    if not enabled:
        return "off"
    if kind == "ONIMBOTV2JOINCHAT":
        return "greet"
    body = (text or "").strip()
    if normalize_command(command) == TICKET_COMMAND or body == TICKET_COMMAND:
        return "ask"
    pressed = button_kind(body, command)
    if pressed:
        return pressed
    slash = _SLASH.get(normalize_command(command))
    if slash:
        return slash
    if not body:
        return "skip"
    if waiting:
        return "take"
    return "nudge"
