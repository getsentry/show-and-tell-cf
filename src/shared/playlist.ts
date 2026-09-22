export interface PlaylistItem {
  submissionId: string;
  videoId: string;
  title: string;
  description: string | null;
  creatorName: string;
  durationSeconds: number;
}

export interface PlaylistResponse {
  event: {id: string; title: string; description: string | null};
  items: PlaylistItem[];
}

export function playlistPath(eventId: string) {
  return `/playlists/${encodeURIComponent(eventId)}`;
}

/** Only known local player routes may be used as OAuth return destinations. */
export function safeReturnTo(value: string | undefined) {
  return value && /^\/playlists\/[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : '/';
}
