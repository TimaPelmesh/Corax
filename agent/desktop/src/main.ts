import { invoke } from "@tauri-apps/api/core";

type AgentStatus = {
  hostname: string;
  serverUrl: string;
  lastRun: string;
  lastRunPath: string;
};

function hourGreeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return "Доброго утра";
  if (h >= 12 && h < 18) return "Доброго дня";
  if (h >= 18 && h < 23) return "Доброго вечера";
  return "Доброй ночи";
}

async function refresh() {
  const hello = document.getElementById("hello");
  const pc = document.getElementById("pc");
  const status = document.getElementById("status");
  if (!hello || !pc || !status) return;
  try {
    const s = await invoke<AgentStatus>("agent_status");
    hello.textContent = hourGreeting();
    pc.textContent = s.hostname ? `Этот компьютер · ${s.hostname}` : "Этот компьютер";
    const text = (s.lastRun || "").trim();
    status.textContent = text || "Отчёта ещё не было.\nПосле ZIP-агента или следующего сбора здесь появится status: OK.";
  } catch {
    hello.textContent = hourGreeting();
    status.textContent = "Не удалось прочитать статус.";
  }
}

window.addEventListener("DOMContentLoaded", () => {
  void refresh();
  document.getElementById("hide-btn")?.addEventListener("click", () => {
    void invoke("hide_main");
  });
  document.getElementById("ticket-btn")?.addEventListener("click", () => {
    void invoke("open_helpdesk");
  });
});
