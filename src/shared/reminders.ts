export interface ShowReminder {
  eventId: string;
  eventTitle: string;
  channel: 'email' | 'slack';
  status: 'pending' | 'sending' | 'sent' | 'uncertain' | 'failed' | 'skipped';
  scheduledAt: string;
  timezone: string;
  destination: string;
  blockedReasons: string[];
  subject: string | null;
  message: string | null;
  submissionUrl: string | null;
  attemptedAt: string | null;
  completedAt: string | null;
}

export interface ShowRemindersResponse {
  enabled: boolean;
  reminders: ShowReminder[];
  nextOffset: number | null;
}
