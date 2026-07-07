/** Заголовок вкладки браузера по текущему маршруту (как в меню приложения). */
const ROUTE_TITLES: Array<{ path: string; title: string; end?: boolean }> = [
  { path: '/login', title: 'Вход в панель' },
  { path: '/requests/database', title: 'База заявок' },
  { path: '/requests/templates', title: 'Шаблоны заявок' },
  { path: '/requests/stats', title: 'Статистика заявок' },
  { path: '/requests', title: 'Создание заявки', end: true },
  { path: '/knowledge-base/sitemap', title: 'Карта здания' },
  { path: '/knowledge-base/wikirag', title: 'WikiRAG' },
  { path: '/knowledge-base/warehouse', title: 'Склад' },
  { path: '/settings/agent-tokens', title: 'Токены агентов' },
  { path: '/settings/agent-bundle', title: 'Сборка агента' },
  { path: '/settings/categories', title: 'Категории' },
  { path: '/settings/bitrix24', title: 'Bitrix24' },
  { path: '/settings/database', title: 'База данных' },
  { path: '/settings/ldap', title: 'LDAP' },
  { path: '/settings/glpi', title: 'GLPI' },
  { path: '/settings/tags', title: 'Теги' },
  { path: '/software', title: 'Каталог' },
  { path: '/computers', title: 'Парк ПК' },
  { path: '/printers', title: 'Принтеры' },
  { path: '/users', title: 'Пользователи' },
  { path: '/', title: 'Дашборд', end: true },
]

const DEFAULT_TITLE = 'CORAX'

export function titleForPath(pathname: string): string {
  const path = pathname.replace(/\/+$/, '') || '/'
  for (const row of ROUTE_TITLES) {
    if (row.end ? path === row.path : path === row.path || path.startsWith(`${row.path}/`)) {
      return row.title
    }
  }
  return DEFAULT_TITLE
}
