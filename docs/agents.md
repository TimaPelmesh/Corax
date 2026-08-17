# Агенты CORAX

ПК сами не появляются в панели. Их присылает **агент** — маленькая программа на каждом компьютере. Она собирает hostname, железо, диски, сеть, ПО и шлёт отчёт на сервер.

Полная инструкция также в панели: **База знаний → Руководство** (разделы «Агент инвентаризации» и «Linux-агент»).

## Сборка (только с панели)

1. Откройте панель по **LAN-IP** (`http://192.168.x.x:3000`), не через `127.0.0.1` и не через Docker `172.x`.
2. Войдите как **админ**.
3. **Настройки → Сборка агента** (`/settings/agent-bundle`).
4. Проверьте URL: схема `http`/`https` должна совпадать с режимом HTTPS сервера, порт обычно **3000**.
5. Выберите пакет и скачайте. URL сервера и токен **вшиваются в файл** — руками вставлять ничего не нужно.

В `backend/.env` на сервере полезно:

```env
CORAX_ADVERTISE_HOST=192.168.x.x
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,http://192.168.x.x:3000
```

После правки `.env`: `npm run docker:restart`.

## Три пакета

| Кнопка на панели | Файл | Куда ставить |
|------------------|------|----------------|
| **EXE C++ (рекомендуется)** | `CORAX-Agent-*.exe` | Любая папка на ПК (или шара). Сам определяет Win7/10/11. |
| **ZIP Windows (7 / 10 / 11)** | `corax-agent-windows-*.zip` | Отдельная папка, **не** каталог сервера CORAX. Один архив на все Windows. |
| **ZIP Linux (bash)** | `corax-agent-linux-*.zip` | Только `/opt/corax-agent`. |

Исходники в git (`agent/…`) — **не для запуска на проде**. Это шаблоны без URL/токена. Рабочий пакет — только скачанный с панели.

## Куда нельзя класть агент

| Нельзя | Почему |
|--------|--------|
| `/opt/corax` и `…/agent/linux` внутри сервера | Это git сервера. Там плейсхолдеры `__INVENTORY_SERVER__`, агент ходит «в никуда», на проде кажется что «всё упало». |
| Рядом с `docker-compose.yml`, `backend/.env`, `run.py` | Скрипт откажется стартовать (защита прода). |
| `127.0.0.1` в URL агента | С чужого ПК отчёт не дойдёт до CORAX. |

Windows ZIP: `%ProgramData%\CORAX\agent` или `\\fileserver\corax\agent`.  
Linux ZIP: `/opt/corax-agent`. Сервер остаётся в `/opt/corax`.

## Токены

Каждая сборка с панели создаёт **новый** токен (`public_id.secret`). В БД хранится только HMAC. Полный секрет вшит в EXE / `agent_env.bat` / `agent_env.sh`.

- Список и отзыв: **Настройки → Токены агентов**.
- Один ZIP/EXE можно раскатать на много ПК.
- Пересборка = другой токен; старый живёт, пока не отзовёте.
- Не публикуйте ZIP/EXE и не коммитьте `agent_env.*`.

## EXE C++

1. Скачайте EXE с панели.
2. На ПК: двойной клик — splash и отправка.
3. Планировщик: `CORAX-Agent.exe --silent` (ежедневно/еженедельно).
4. После смены HTTP↔HTTPS на сервере — **скачайте EXE заново**.

## ZIP Windows — первый запуск

Внутри один архив:

```
corax_send.bat          ← запускать ЭТО (сам выберет Win7 или 10/11)
agent_env.bat           ← URL + токен (не затирать при обновлении)
agent_config.json
update_scripts.bat
win10\                  ← PowerShell 5+ (Windows 10/11)
win7\                   ← Windows 7 / старый PowerShell
```

`corax_send.bat` смотрит версию PowerShell: 5+ → `win10\`, иначе → `win7\`.

```bat
:: на ПК или с шары
cd /d %ProgramData%\CORAX\agent
corax_send.bat
:: без паузы (планировщик):
corax_send.bat nopause
```

Проверка: **Компьютеры** — появился hostname, обновилось «последний отчёт».

Расписание: если при сборке включили автозапуск, в ZIP будет `install_schedule.bat` — один раз **от администратора**. Задача называется `CORAX-Agent` и всегда стартует корневой `corax_send.bat` (ОС определяется каждый раз).

## ZIP Windows — обновление скриптов

**Нельзя** распаковать новый ZIP поверх живой папки (`unzip -o` / «с заменой»). Затрётся `agent_env.bat` — URL и токен пропадут, агент перестанет слать отчёты (та же ошибка, что с Linux).

Правильно:

1. Новый ZIP с панели распаковать во **временную** папку, например `C:\temp\corax-agent-new`.
2. Из **живой** папки:

```bat
cd /d %ProgramData%\CORAX\agent
update_scripts.bat C:\temp\corax-agent-new
```

`agent_env.bat` останется. Можно вручную копировать только `win10\`, `win7\`, `corax_send.bat` — `agent_env.bat` не трогать.

## ZIP Linux — первый запуск

Два каталога, их нельзя путать:

| Путь | Что это |
|------|---------|
| `/opt/corax` | Сервер: git, Docker, `backend/.env`. Агент **отсюда не запускать**. |
| `/opt/corax-agent` | Только содержимое ZIP с панели. |

```bash
sudo mkdir -p /opt/corax-agent
sudo unzip -o corax-agent-linux-*.zip -d /opt/corax-agent
cd /opt/corax-agent
chmod +x run_console.sh corax_send.sh inventory_agent.sh install_cron.sh update_scripts.sh
/bin/sh ./run_console.sh
sudo ./install_cron.sh    # опционально, или systemd/ из ZIP
```

Агент не читает `backend/.env` и не пишет в PostgreSQL. Если «сервер не отвечает» — смотрите Docker (`cd /opt/corax && docker compose --env-file backend/.env logs app`), не правьте `.env` вслепую.

## ZIP Linux — обновление скриптов

`unzip -o new.zip -d /opt/corax-agent` **затирает** `agent_env.sh`.

```bash
sudo unzip -o corax-agent-linux-*.zip -d /tmp/corax-agent-new
sudo /bin/sh /opt/corax-agent/update_scripts.sh /tmp/corax-agent-new
```

Либо: `unzip -o new.zip -x agent_env.sh -d /opt/corax-agent` (только если `agent_env.sh` уже есть).

Первая установка — без `-x`, иначе в каталоге не будет URL/токена.

## HTTPS

Один порт `:3000` = одна схема. Включили TLS в **Настройки → HTTPS** → перезапуск контейнера → **пересоберите агентов с https://**. Старый пакет с `http://` отчёты больше не отправит. На ПК агентов нужен доверенный `ca.crt` (GPO или `scripts/install-corax-ca.bat`).

## Что присылает агент

Hostname, серийник, CPU/RAM, диски, NIC/IP/MAC, ОС, установленное ПО, периферия. Повторяется по расписанию. Без токена API отвечает отказом.

```http
POST http://<LAN-IP>:3000/api/v1/agent/inventory
Authorization: Bearer <token>
```

## Типичные ошибки

| Что сделали | Симптом | Что делать |
|-------------|---------|------------|
| Запуск из `/opt/corax/agent/linux` | HTTP 000, `__INVENTORY_SERVER__` | ZIP в `/opt/corax-agent` |
| Запуск Windows-скриптов из git сервера | отказ / плейсхолдер | ZIP в `%ProgramData%\CORAX\agent` |
| `unzip -o` поверх живого агента | пропал URL/токен | `update_scripts.sh` / `update_scripts.bat` |
| URL `127.0.0.1` или `172.17–24.x` | отчёт не доходит | панель по LAN-IP; `CORAX_ADVERTISE_HOST` |
| Сменили HTTP↔HTTPS, старый пакет | агент молчит | новая сборка с панели |
| Нет сети до :3000 | агент молчит | `curl http://<LAN-IP>:3000/api/v1/health/ready` |
| Скопировали `agent_env.sh.example` без правки | EXIT 2 | только ZIP с панели |

В ZIP: Windows — `README_DEPLOY.txt`; Linux — `README.txt`.
