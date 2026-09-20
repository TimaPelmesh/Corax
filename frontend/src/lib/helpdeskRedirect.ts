/** Old /r bookmarks keep working by opening the only public helpdesk: /h. */
export function legacySelfServiceLocation(hash: string): { pathname: '/h'; hash: string } {
  return { pathname: '/h', hash: hash || '' }
}
