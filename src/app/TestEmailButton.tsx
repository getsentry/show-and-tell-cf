import {useRef, useState} from 'react';
import {api, errorMessage} from './api';

export function TestEmailButton({eventId}: {eventId: string}) {
  const requestId = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<'sent' | 'sending' | 'uncertain' | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function send() {
    if (busy) return;
    // Reuse the attempt after a network error; never blindly resend.
    requestId.current ??= crypto.randomUUID();
    setBusy(true);
    setError('');
    try {
      const result = await api<{
        status: 'sent' | 'sending' | 'uncertain';
        recipient: string;
      }>('/admin/reminders/test-email', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({eventId, requestId: requestId.current}),
      });
      setStatus(result.status);
      setNotice(
        result.status === 'sent'
          ? `Test accepted for ${result.recipient}. Check your inbox.`
          : 'Delivery is pending or uncertain. Check your inbox before starting another test.',
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="reminderTest">
      <p className="formHint">
        Sends a [TEST] email only to your signed-in Sentry address. Scheduled reminders
        stay unchanged.
      </p>
      <div className="actionGroup">
        <button
          disabled={busy || status === 'sent' || status === 'uncertain'}
          onClick={() => void send()}
        >
          {requestId.current ? 'Check test attempt' : 'Send test to me'}
        </button>
        {requestId.current ? (
          <button
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  'Start another test? Check your inbox first; the previous email may already have arrived.',
                )
              )
                return;
              requestId.current = null;
              setStatus(null);
              setNotice('');
              setError('');
            }}
          >
            Start another test
          </button>
        ) : null}
      </div>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
