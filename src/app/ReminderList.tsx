import {useEffect, useState} from 'react';
import type {ShowReminder, ShowRemindersResponse} from '../shared/reminders';
import {submissionPath} from '../shared/playlist';
import {api, errorMessage} from './api';

const statusLabels = {
  pending: 'Pending',
  sending: 'Sending',
  sent: 'Accepted by provider',
  uncertain: 'Delivery uncertain',
  failed: 'Failed',
  skipped: 'Skipped',
} satisfies Record<ShowReminder['status'], string>;

export function ReminderList() {
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<ShowRemindersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    void api<ShowRemindersResponse>(`/admin/reminders?offset=${offset}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [offset, revision]);
  return (
    <section className="reminderPanel" aria-label="Scheduled reminders">
      <div className="overviewHeading">
        <h2>Reminders</h2>
        <button className="textAction" onClick={() => setRevision((value) => value + 1)}>
          Refresh reminders
        </button>
      </div>
      <p className="formHint">
        Pending upcoming reminders appear first. Delivery runs hourly at minute 17 UTC, on
        the first check after the due time. This read-only view does not send messages.
      </p>
      {error ? (
        <p role="alert">{error}</p>
      ) : !data ? (
        <p role="status">Loading reminders…</p>
      ) : (
        <>
          <p className="reminderMode" role="status">
            {data.enabled
              ? 'Automatic reminders enabled'
              : 'Automatic reminders disabled — nothing will be sent or revealed automatically.'}
          </p>
          <p className="formHint">
            Previews and destinations reflect current configuration, not a historical
            sent-message archive. Slack channel labels are configured by an operator; the
            webhook controls the actual destination.
          </p>
          {data.reminders.length ? (
            <ul className="reminderList">
              {data.reminders.map((reminder) => (
                <li key={`${reminder.eventId}-${reminder.channel}`}>
                  <article
                    className="reminderCard"
                    aria-label={`${reminder.eventTitle} ${reminder.channel} reminder`}
                  >
                    <header className="reminderHeader">
                      <h3>
                        <a href={submissionPath(reminder.eventId)}>
                          {reminder.eventTitle}
                        </a>
                      </h3>
                      <span className="tag">{statusLabels[reminder.status]}</span>
                    </header>
                    <dl className="reminderMetadata">
                      <div>
                        <dt>Where</dt>
                        <dd>
                          {reminder.channel === 'email' ? 'Email' : 'Slack'} ·{' '}
                          {reminder.destination}
                        </dd>
                      </div>
                      <div>
                        <dt>Due</dt>
                        <dd>
                          <time dateTime={reminder.scheduledAt}>
                            {formatTime(reminder.scheduledAt, reminder.timezone)}
                          </time>
                          <br />
                          <small>{reminder.scheduledAt} (UTC)</small>
                        </dd>
                      </div>
                      {reminder.attemptedAt ? (
                        <div>
                          <dt>Last attempt</dt>
                          <dd>{formatTime(reminder.attemptedAt, reminder.timezone)}</dd>
                        </div>
                      ) : null}
                      {reminder.completedAt ? (
                        <div>
                          <dt>Result recorded</dt>
                          <dd>{formatTime(reminder.completedAt, reminder.timezone)}</dd>
                        </div>
                      ) : null}
                    </dl>
                    {reminder.blockedReasons.length ? (
                      <div className="reminderBlockers">
                        <strong>Current blockers</strong>
                        <ul>
                          {reminder.blockedReasons.map((reason) => (
                            <li key={reason}>{reason}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    <details className="reminderPreview">
                      <summary>Message preview</summary>
                      {reminder.subject ? (
                        <p>
                          <strong>Subject:</strong> {reminder.subject}
                        </p>
                      ) : null}
                      {reminder.message ? (
                        <pre>{reminder.message}</pre>
                      ) : (
                        <p>Preview unavailable. Check the configuration and show date.</p>
                      )}
                      {reminder.channel === 'slack' && reminder.submissionUrl ? (
                        <p>
                          Button: <a href={reminder.submissionUrl}>Submit your demo</a>
                        </p>
                      ) : null}
                    </details>
                  </article>
                </li>
              ))}
            </ul>
          ) : (
            <p>No reminders on this page.</p>
          )}
          <nav className="reminderPagination" aria-label="Reminder pages">
            <button
              disabled={offset === 0}
              onClick={() => setOffset((value) => Math.max(0, value - 50))}
            >
              Previous reminders
            </button>
            <button
              disabled={data.nextOffset === null}
              onClick={() => {
                if (data.nextOffset !== null) setOffset(data.nextOffset);
              }}
            >
              Next reminders
            </button>
          </nav>
        </>
      )}
    </section>
  );
}

function formatTime(value: string, timezone: string) {
  try {
    return `${new Intl.DateTimeFormat('en-US', {dateStyle: 'medium', timeStyle: 'short', timeZone: timezone}).format(new Date(value))} (${timezone})`;
  } catch {
    return value;
  }
}
