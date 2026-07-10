# Unit-файлы systemd для CORAX (Linux).
# Полная инструкция: README.md → «Linux: установка с нуля, systemd, cron».
#
# Рекомендуемый production: только corax-backend.service (UI + API на :3000).
# corax-frontend.service — опциональный split-режим.
#
# Быстрый старт после clone в /opt/corax:
#   sudo cp deploy/corax-backend.service /etc/systemd/system/
#   sudo systemctl daemon-reload
#   sudo systemctl enable --now corax-backend
