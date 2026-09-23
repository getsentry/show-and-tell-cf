export interface ShowAndTellEvent {
  id: string;
  title: string;
  description: string | null;
  createdAt: string;
  submissionCount: number;
  slug?: string;
  hidden?: boolean;
  startsAt?: string | null;
  timezone?: string | null;
  meetingUrl?: string | null;
}

export interface Submission {
  id: string;
  eventId: string;
  creatorId: string;
  creatorName: string;
  creatorAvatarUrl: string | null;
  title: string;
  description: string | null;
  hidden: boolean;
  createdAt: string;
}

export interface EventsResponse {
  events: ShowAndTellEvent[];
}

export interface EventResponse {
  event: ShowAndTellEvent;
  submissions: Submission[];
}
