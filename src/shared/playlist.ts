export interface PlaylistItem {
  submissionId: string;
  videoId: string;
  title: string;
  description: string | null;
  creatorName: string;
  durationSeconds: number;
}

export interface PlaylistResponse {
  event: {id: string; title: string; description: string | null; slug?: string};
  items: PlaylistItem[];
}

export function eventSlug(value: string) {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80)
      .replace(/-$/, '') || 'show-and-tell'
  );
}

export function playlistPath(eventId: string, slug?: string) {
  return `/playlists/${encodeURIComponent(eventId)}${slug ? `/${eventSlug(slug)}` : ''}`;
}

export function submissionPath(eventId: string, slug?: string) {
  return `/events/${encodeURIComponent(eventId)}${slug ? `/${eventSlug(slug)}` : ''}`;
}

export function eventIdFromPath(path: string) {
  return safeReturnTo(path) === '/' ? null : path.split('/')[2];
}

/** Only known local player and submission routes may be used as OAuth return destinations. */
export function safeReturnTo(value: string | undefined) {
  return value &&
    value.length <= 220 &&
    /^\/(?:playlists|events)\/[a-zA-Z0-9_-]{1,128}(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(
      value,
    )
    ? value
    : '/';
}
