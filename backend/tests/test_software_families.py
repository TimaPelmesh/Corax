from __future__ import annotations

from app.software_families import classify_software_name


def test_chrome_and_office_families():
    chrome = classify_software_name("Google Chrome")
    assert chrome is not None and chrome.name == "Google Chrome" and chrome.category == "browser"
    office = classify_software_name("Microsoft Office 365")
    assert office is not None and office.name == "Microsoft Office" and office.category == "office"
    assert classify_software_name("Microsoft Word 2016").name == "Microsoft Office"
    assert classify_software_name("LibreOffice 24.2").name == "LibreOffice"
    assert classify_software_name("МойОфис Стандартный").name == "МойОфис"


def test_skip_updaters_and_remote_desktop():
    assert classify_software_name("Chrome Remote Desktop") is None
    assert classify_software_name("Microsoft Edge Update") is None
    assert classify_software_name("Google Chrome") is not None


def test_yandex_and_edge():
    assert classify_software_name("Yandex Browser").name == "Yandex Browser"
    assert classify_software_name("Microsoft Edge").name == "Microsoft Edge"


def test_real_agent_display_names():
    assert classify_software_name("google-chrome-stable").name == "Google Chrome"
    assert classify_software_name("Яндекс.Браузер").name == "Yandex Browser"
    assert classify_software_name("Microsoft® Office Professional Plus 2019").name == "Microsoft Office"
    assert classify_software_name("chromium-browser").name == "Chromium"
    assert classify_software_name("firefox-esr").name == "Mozilla Firefox"
