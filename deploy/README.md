# Unit-файлы systemd для CORAX (Linux).
# Полная инструкция: README.md → «Linux: установка с нуля, systemd, cron»
# (руководство по развёртыванию: пакеты, PostgreSQL, .env, systemd, cron, проверки).
#
# Рекомендуемый production: только corax-backend.service (UI + API на :3000).
# corax-frontend.service — опциональный split-режим (API :3001 + preview :3000).
# Не используйте --reload / npm run dev в unit-файлах.
#
# Быстрый старт после clone в /opt/corax:
#   sudo cp deploy/corax-backend.service /etc/systemd/system/
#   sudo systemctl daemon-reload
#   sudo systemctl enable --now corax-backend
#   curl -sS http://127.0.0.1:3000/api/v1/health
#
# Ночные обновления: chmod +x update.sh + cron
#   0 4 * * * /bin/bash /opt/corax/update.sh >> /var/log/corax_update.log 2>&1
# Если cron от root: sudo git config --global --add safe.directory /opt/corax
