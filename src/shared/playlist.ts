export interface PlaylistItem {
  submissionId: string;
  videoId: string;
  title: string;
  description: string | null;
  creatorName: string;
  creatorAvatarUrl: string | null;
  durationSeconds: number;
}

export interface PlaylistResponse {
  event: {id: string; title: string; description: string | null; slug?: string};
  items: PlaylistItem[];
}

const ID = '[a-zA-Z0-9_-]{1,128}';
const SLUG = '(?:/[a-z0-9]+(?:-[a-z0-9]+)*)?';

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

/** A screening link, optionally pointing at one video in its lineup. */
export function playlistPath(eventId: string, slug?: string, videoId?: string | null) {
  const path = `/playlists/${encodeURIComponent(eventId)}${slug ? `/${eventSlug(slug)}` : ''}`;
  return videoId ? `${path}?video=${encodeURIComponent(videoId)}` : path;
}

/** The video a screening link points at, if its id is well formed. */
export function linkedVideoId(search: string) {
  const id = new URLSearchParams(search).get('video');
  return id && new RegExp(`^${ID}$`).test(id) ? id : null;
}

export function submissionPath(eventId: string, slug?: string) {
  return `/events/${encodeURIComponent(eventId)}${slug ? `/${eventSlug(slug)}` : ''}`;
}

export function eventIdFromPath(path: string) {
  return safeReturnTo(path) === '/' ? null : path.split(/[/?]/)[2];
}

const RETURN_TO = new RegExp(
  `^/(?:events/${ID}${SLUG}|playlists/${ID}${SLUG}(?:\\?video=${ID})?)$`,
);

/** Only known local player and submission routes may be used as OAuth return
 * destinations. Screening links may also point at one video. */
export function safeReturnTo(value: string | undefined) {
  return value && value.length <= 360 && RETURN_TO.test(value) ? value : '/';
}
