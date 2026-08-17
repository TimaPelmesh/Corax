"""Parse / render warehouse CSV.

Accepts CORAX export and typical GLPI cartridge/item dumps
(semicolon or comma, UTF-8 / Windows-1251, RU or EN headers).
Identical rows without a serial are merged into one lot —
write-off later happens against that single row, not 20 GLPI clones.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, replace

_PRESET_HINTS: list[tuple[str, tuple[str, ...]]] = [
    ("cartridge", ("картридж", "тонер", "toner", "cartridge", "drum", "барабан")),
    ("ram", ("озу", "оператив", " ram", "ddr", "so-dimm", "sodimm")),
    ("ssd", ("ssd", "nvme", "m.2", "m2")),
    ("hdd", ("hdd", "жестк", "hard disk", "hard drive")),
    ("cpu", ("процессор", "cpu", "ryzen", "core i")),
    ("gpu", ("видеокарт", "gpu", "geforce", "radeon")),
    ("motherboard", ("материнск", "motherboard", "mainboard")),
    ("psu", ("блок питания", "psu", "power supply")),
    ("case", ("корпус", "case chassis")),
    ("cooler", ("кулер", "cooler", "охлажд")),
    ("optical", ("оптическ", "dvd", "bluray", "blu-ray")),
    ("printer", ("принтер", "printer", "мфу", "mfp")),
    ("mouse", ("мышь", "мыши", "mouse")),
    ("keyboard", ("клавиатур", "keyboard")),
    ("headset", ("гарнитур", "headset", "наушник")),
    ("webcam", ("веб-камер", "webcam", "web cam")),
    ("docking", ("док", "docking")),
    ("ups", ("ибп", "ups", "источник бесперебой")),
    ("cable_usb", ("usb", "адаптер", "adapter", "кабель usb")),
    ("switch", ("коммутатор", "switch")),
    ("ap", ("точка доступа", "access point", "точки доступа")),
    ("router", ("маршрутизатор", "router", "роутер")),
    ("patch_cord", ("патч", "patch", "витая", "utp", "ftp", "кабель")),
    ("monitor", ("монитор", "monitor", "дисплей", "display")),
    ("peripheral", ("перифер", "peripheral")),
]

_LOT_HINTS = (
    "расходн",
    "consumable",
    "картридж",
    "cartridge",
    "тонер",
    "toner",
    "кабель",
    "cable",
    "патч",
    "patch",
)

_UNIT_HINTS = (
    "монитор",
    "monitor",
    "принтер",
    "printer",
    "коммутатор",
    "switch",
    "ssd",
    "hdd",
    "процессор",
)

_ALIASES: dict[str, tuple[str, ...]] = {
    "name": (
        "наименование",
        "название",
        "name",
        "модель",
        "model",
        "designation",
        "consumable",
        "cartridge",
        "item",
    ),
    "manufacturer": ("производитель", "manufacturer", "vendor", "бренд", "brand"),
    "type": (
        "тип расходного материала",
        "тип",
        "type",
        "consumable type",
        "cartridge type",
        "item type",
        "категория",
        "preset",
        "preset_key",
    ),
    "tracking": ("учёт", "учет", "tracking", "tracking_mode", "как учитывать"),
    "quantity": (
        "количество",
        "кол-во",
        "qty",
        "quantity",
        "count",
        "остаток",
        "осталось",
        "in stock",
        "unused",
        "stock",
        "расходные материалы",
        "consumables",
        "cartridges",
        "картриджи",
    ),
    "condition": ("состояние", "condition", "status", "state", "статус"),
    "room": ("местоположение", "помещение", "комната", "location", "room", "склад"),
    "code": ("код ск", "код", "internal_code", "sk", "складской код", "inventory number", "инвентарный номер"),
    "serial": ("серийный номер", "serial", "serial number", "s/n", "sn"),
    "batch": ("артикул", "reference", "ref", "партия", "batch", "поставка", "ссылочный номер"),
    "notes": ("примечание", "комментарии", "комментарий", "comment", "comments", "notes", "note"),
    "external_id": ("id glpi", "glpi id", "glpi_id", "id", "external_id"),
}

_QTY_HEADER_EXACT = {
    "расходные материалы",
    "consumables",
    "cartridges",
    "картриджи",
    "количество",
    "кол-во",
}

_GROUP_RANK = {"components": 0, "peripherals": 1, "network": 2, "other": 3}


@dataclass(frozen=True)
class ParsedStockRow:
    name: str
    manufacturer: str | None
    preset_key: str
    tracking_mode: str
    quantity: int
    condition: str
    room_title: str | None
    internal_code: str | None
    serial_number: str | None
    batch_label: str | None
    notes: str | None
    external_id: str | None


def read_text_best_effort(raw: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "cp1251"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    raise ValueError("Не удалось прочитать CSV (кодировка). Попробуйте UTF-8 или Windows-1251.")


def _norm_header(value: str | None) -> str:
    text = (value or "").lstrip("\ufeff").strip().casefold().replace("ё", "е")
    text = re.sub(r"[\s_\-–—/]+", " ", text)
    return text.strip(" :")


def _detect_dialect(text: str) -> csv.Dialect:
    sample = text[:16384]
    try:
        return csv.Sniffer().sniff(sample, delimiters=";,\t")
    except csv.Error:
        first_line = next((line for line in text.splitlines() if line.strip()), "")
        delimiter = max((";", ",", "\t"), key=first_line.count) if first_line else ";"

        class Fallback(csv.excel):
            pass

        Fallback.delimiter = delimiter or ";"
        return Fallback


def _header_matches(norm_header: str, alias: str) -> bool:
    if not alias or not norm_header:
        return False
    if norm_header == alias:
        return True
    # Truncated Excel titles: "Наименов" → "наименование"
    if len(norm_header) >= 6 and len(alias) >= 6 and alias.startswith(norm_header):
        return True
    if len(alias) >= 4 and norm_header.startswith(f"{alias} "):
        return True
    return False


def _map_columns(fieldnames: list[str] | None) -> dict[str, str | None]:
    headers = [h for h in (fieldnames or []) if h]
    normalized = {_norm_header(h): h for h in headers}
    used: set[str] = set()
    columns: dict[str, str | None] = {}
    for field, aliases in _ALIASES.items():
        found: str | None = None
        norms = [_norm_header(a) for a in aliases]
        for alias in norms:
            if alias in normalized and normalized[alias] not in used:
                found = normalized[alias]
                break
        if found is None and field != "external_id":
            for norm_header, original in normalized.items():
                if original in used:
                    continue
                if any(_header_matches(norm_header, alias) for alias in norms):
                    found = original
                    break
        columns[field] = found
        if found:
            used.add(found)
    if columns["quantity"] is None:
        for norm_header, original in normalized.items():
            if original in used:
                continue
            if norm_header in _QTY_HEADER_EXACT or norm_header.startswith("расходные материал"):
                columns["quantity"] = original
                break
    return columns


def _cell(row: dict[str, str], column: str | None) -> str:
    if not column:
        return ""
    return (row.get(column) or "").strip()


def _parse_qty(raw: str) -> int:
    """Shelf quantity. GLPI dumps 'Всего: 12, Новых 4, Использованных 8' — take New/Новых (on the shelf), not Used."""
    s = (raw or "").strip().replace("\u00a0", " ")
    if not s:
        return 1
    new_m = re.search(r"(?:новых|unused|\bnew\b)\s*:?\s*(\d+)", s, flags=re.IGNORECASE)
    if new_m:
        return max(0, min(int(new_m.group(1)), 9999))
    total_m = re.search(r"(?:всего|total)\s*:?\s*(\d+)", s, flags=re.IGNORECASE)
    if total_m:
        return max(0, min(int(total_m.group(1)), 9999))
    s_num = s.replace(",", ".")
    m = re.search(r"(\d+(?:\.\d+)?)", s_num)
    if not m:
        return 1
    return max(0, min(int(float(m.group(1))), 9999))


def guess_preset(type_text: str, name: str) -> str:
    blob = f"{type_text} {name}".casefold().replace("ё", "е")
    for key, hints in _PRESET_HINTS:
        if any(h in blob for h in hints):
            return key
    return "other"


_DEFAULT_TRACKING: dict[str, str] = {key: "lot" for key in (
    "ram", "ssd", "hdd", "cpu", "gpu", "motherboard", "psu", "case", "cooler",
    "optical", "printer", "mouse", "keyboard", "headset", "webcam", "cartridge",
    "docking", "ups", "cable_usb", "switch", "ap", "router", "patch_cord",
    "monitor", "peripheral", "other",
)}


def _guess_tracking(preset_key: str, type_text: str, serial: str | None, quantity: int, explicit: str) -> str:
    exp = explicit.casefold().replace("ё", "е")
    if exp in ("unit", "оборудование", "поштучно", "unit-by-unit", "equipment"):
        return "lot"
    return "lot"


def _guess_condition(raw: str) -> str:
    s = raw.casefold().replace("ё", "е")
    if any(x in s for x in ("брак", "defect", "broken", "fault", "неисправ")):
        return "defective"
    if any(x in s for x in ("б/у", "бу ", "used", "б у", "бывш")):
        return "used"
    return "new"


def parse_warehouse_csv(text: str) -> tuple[list[ParsedStockRow], list[str]]:
    """Return parsed rows and non-fatal warnings. Raises ValueError if unusable."""
    reader = csv.DictReader(io.StringIO(text), dialect=_detect_dialect(text))
    columns = _map_columns(list(reader.fieldnames or []))
    if columns["name"] is None:
        shown = ", ".join((reader.fieldnames or [])[:8]) or "—"
        raise ValueError(
            "Не найдена колонка с названием. Нужен CSV склада CORAX или выгрузка GLPI "
            f"(Название / Name / Consumable). Колонки файла: {shown}"
        )
    warnings: list[str] = []
    rows: list[ParsedStockRow] = []
    skipped_empty = 0
    skipped_qty = 0
    for i, raw in enumerate(reader, start=2):
        name = _cell(raw, columns["name"])
        if not name:
            skipped_empty += 1
            continue
        type_text = _cell(raw, columns["type"])
        serial = _cell(raw, columns["serial"]) or None
        qty = _parse_qty(_cell(raw, columns["quantity"]))
        if qty <= 0:
            skipped_qty += 1
            continue
        preset_key = guess_preset(type_text, name)
        tracking = _guess_tracking(preset_key, type_text, serial, qty, _cell(raw, columns["tracking"]))
        ext = _cell(raw, columns["external_id"]) or None
        rows.append(
            ParsedStockRow(
                name=name[:512],
                manufacturer=(_cell(raw, columns["manufacturer"]) or None),
                preset_key=preset_key,
                tracking_mode=tracking,
                quantity=qty,
                condition=_guess_condition(_cell(raw, columns["condition"])),
                room_title=(_cell(raw, columns["room"]) or None),
                internal_code=(_cell(raw, columns["code"]) or None),
                serial_number=serial,
                batch_label=(_cell(raw, columns["batch"]) or None),
                notes=(_cell(raw, columns["notes"]) or None),
                external_id=ext[:64] if ext else None,
            )
        )
    if skipped_empty:
        warnings.append(f"Пропущено строк без названия: {skipped_empty}")
    if skipped_qty:
        warnings.append(f"Пропущено позиций с нулевым остатком (только использованные в GLPI): {skipped_qty}")
    if not rows:
        raise ValueError("В CSV нет ни одной позиции с названием")
    return rows, warnings


def merge_consumable_rows(rows: list[ParsedStockRow]) -> list[ParsedStockRow]:
    """Collapse identical lot rows (typical GLPI: one CSV line per cartridge)."""
    merged: dict[tuple, ParsedStockRow] = {}
    order: list[tuple] = []
    for row in rows:
        if row.tracking_mode != "lot" or row.serial_number or row.internal_code:
            key = ("unit", id(row))
            merged[key] = row
            order.append(key)
            continue
        key = (
            "lot",
            row.name.casefold(),
            (row.manufacturer or "").casefold(),
            row.preset_key,
            (row.room_title or "").casefold(),
            row.condition,
            (row.batch_label or "").casefold(),
        )
        if key not in merged:
            merged[key] = row
            order.append(key)
        else:
            prev = merged[key]
            notes = prev.notes
            extra_id = row.external_id
            if extra_id and extra_id != prev.external_id:
                bit = f"GLPI {extra_id}"
                notes = f"{notes}; {bit}".strip("; ") if notes else bit
            merged[key] = replace(
                prev,
                quantity=min(9999, prev.quantity + row.quantity),
                notes=notes,
            )
    return [merged[k] for k in order]


EXPORT_HEADERS = [
    "Наименование",
    "Организация",
    "Артикул",
    "Тип",
    "Производитель",
    "Местоположение",
    "Количество",
    "Учёт",
    "Состояние",
    "Код СК",
    "Серийный номер",
    "Партия",
    "Примечание",
    "ID GLPI",
    "ID CORAX",
]

_CONDITION_RU = {"new": "новое", "used": "б/у", "defective": "брак"}
_TRACKING_RU = {"lot": "позиции", "unit": "позиции"}


def render_warehouse_csv(
    items: list[dict],
    *,
    preset_name: dict[str, str],
    room_title: dict[int, str],
    preset_group: dict[str, str] | None = None,
    organization: str = "",
) -> bytes:
    pg = preset_group or {}
    ordered = sorted(
        items,
        key=lambda it: (
            _GROUP_RANK.get(pg.get(it.get("preset_key") or "", "other"), 9),
            (preset_name.get(it.get("preset_key") or "", it.get("preset_name") or "") or "").casefold(),
            (it.get("name") or "").casefold(),
            int(it.get("id") or 0),
        ),
    )
    buf = io.StringIO()
    wr = csv.writer(buf, delimiter=";", quoting=csv.QUOTE_MINIMAL, lineterminator="\r\n")
    wr.writerow(EXPORT_HEADERS)
    for it in ordered:
        tracking = it.get("tracking_mode") or "lot"
        qty = it.get("quantity_available") if it.get("quantity_available") is not None else it.get("quantity") or 1
        wr.writerow(
            [
                it.get("name") or "",
                organization,
                it.get("batch_label") or "",
                preset_name.get(it.get("preset_key") or "", it.get("preset_name") or it.get("preset_key") or ""),
                it.get("manufacturer") or "",
                room_title.get(int(it["room_id"]), "") if it.get("room_id") is not None else "",
                int(qty or 0),
                _TRACKING_RU.get(tracking, tracking),
                _CONDITION_RU.get(it.get("condition") or "", it.get("condition") or ""),
                it.get("internal_code") or "",
                it.get("serial_number") or "",
                it.get("batch_label") or "",
                it.get("notes") or "",
                it.get("external_id") or "",
                it.get("id") or "",
            ]
        )
    return ("\ufeff" + buf.getvalue()).encode("utf-8")
