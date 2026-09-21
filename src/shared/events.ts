export interface ShowAndTellEvent {
  id: string;
  title: string;
  description: string | null;
  createdAt: string;
  submissionCount: number;
}

export interface Submission {
  id: string;
  eventId: string;
  creatorId: string;
  creatorName: string;
  title: string;
  description: string | null;
  projectUrl: string;
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
