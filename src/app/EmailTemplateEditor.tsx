import {useEffect, useState, useRef} from 'react';
import {
  defaultEmailTemplate,
  templateFields,
  templateTokens,
  type EmailTemplateResponse,
  type EmailPreview,
  templateFieldKeys,
} from '../shared/email-template';
import {api, errorMessage} from './api';

export function EmailPreviewFrame({html}: {html: string}) {
  // No scripts, forms, same-origin access, navigation of the parent, or remote assets.
  const document = html.replace(
    '<head>',
    "<head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'none'; base-uri 'none'\">",
  );
  return (
    <iframe
      className="emailPreviewFrame"
      title="Rendered email preview"
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={document}
    />
  );
}

export function EmailTemplateEditor({
  shows,
  onSaved,
}: {
  shows: {id: string; title: string}[];
  onSaved: () => void;
}) {
  const [data, setData] = useState<EmailTemplateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [eventId, setEventId] = useState(shows[0]?.id ?? '');
  const [preview, setPreview] = useState<EmailPreview | null>(null);
  const testPayload = useRef<string | null>(null);
  const [testStatus, setTestStatus] = useState<'sent' | 'sending' | 'uncertain' | null>(
    null,
  );
  const [testStarted, setTestStarted] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    void api<EmailTemplateResponse>('/admin/email-template', {signal: controller.signal})
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [reload]);
  async function act(action: 'save' | 'preview') {
    if (!data || busy) return;
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const init = {
        method: action === 'save' ? 'PUT' : 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({...data, eventId}),
      };
      if (action === 'save') {
        setData(await api<EmailTemplateResponse>('/admin/email-template', init));
        setNotice('Saved for future email attempts. Nothing was sent.');
        onSaved();
      } else setPreview(await api<EmailPreview>('/admin/email-template/preview', init));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function sendTest() {
    if (!data || !preview || busy) return;
    // Keep this payload across network errors: checking the same attempt cannot resend.
    testPayload.current ??= JSON.stringify({
      eventId,
      template: data.template,
      requestId: crypto.randomUUID(),
    });
    setTestStarted(true);
    setBusy(true);
    setError(null);
    setNotice('');
    try {
      const result = await api<{
        status: 'sent' | 'sending' | 'uncertain';
        recipient: string;
      }>('/admin/email-template/test', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: testPayload.current,
      });
      setTestStatus(result.status);
      setNotice(
        result.status === 'sent'
          ? `Test accepted by the email provider for ${result.recipient}. Check your inbox. The template and scheduled reminders are unchanged.`
          : `Test delivery ${result.status === 'sending' ? 'is in progress or its outcome is unknown' : 'is uncertain'}. Check your inbox before starting another test. No automatic retry will send a second email.`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="emailTemplateEditor" aria-label="Email template editor">
      <h3>Email template</h3>
      <p className="formHint">
        One shared template for future email attempts, not per-show copy. Saving does not
        send or retry anything. Already accepted or in-flight messages are not changed.
        There is no submission deadline; the videos available when the show starts are
        used.
      </p>
      <p className="formHint">
        Plain text only; the branded layout and submission links are generated safely. In
        Help and contacts, separate sections with a blank line. The first line of each
        section becomes a bold label; following lines are regular text. Placeholders:{' '}
        {templateTokens.map((token) => (
          <code key={token}>{`{{${token}}} `}</code>
        ))}
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {!data ? (
        <>
          <p>Loading template…</p>
          <button onClick={() => setReload((value) => value + 1)}>Reload template</button>
        </>
      ) : (
        <>
          <fieldset disabled={busy}>
            <legend>Template copy</legend>
            {templateFieldKeys.map((key) => (
              <label key={key}>
                {templateFields[key].label}
                <textarea
                  rows={key === 'intro' || key === 'participation' ? 4 : 2}
                  maxLength={templateFields[key].max}
                  value={data.template[key]}
                  onChange={(event) => {
                    setData({
                      ...data,
                      template: {...data.template, [key]: event.target.value},
                    });
                    setPreview(null);
                    setNotice('');
                  }}
                />
              </label>
            ))}
            <label>
              Demo length: under this many minutes
              <input
                type="number"
                min="1"
                max="60"
                value={data.template.demoMinutes}
                onChange={(event) => {
                  setData({
                    ...data,
                    template: {...data.template, demoMinutes: Number(event.target.value)},
                  });
                  setPreview(null);
                }}
              />
            </label>
            <label>
              Preview show (current reminder page)
              <select
                value={eventId}
                onChange={(event) => {
                  setEventId(event.target.value);
                  setPreview(null);
                }}
              >
                <option value="">Select a show</option>
                {shows.map((show) => (
                  <option key={show.id} value={show.id}>
                    {show.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="emailTemplateActions">
              <button disabled={!eventId} onClick={() => void act('preview')}>
                Preview draft email
              </button>
              <button onClick={() => void act('save')}>Save email template</button>
              <button
                onClick={() => {
                  setData({...data, template: {...defaultEmailTemplate}});
                  setPreview(null);
                  setNotice('Defaults loaded into draft. Save to apply.');
                }}
              >
                Use default copy
              </button>
              <button
                onClick={() => {
                  setPreview(null);
                  setNotice('');
                  setReload((value) => value + 1);
                }}
              >
                Reload saved template
              </button>
            </div>
          </fieldset>
          <p className="formHint">
            Preview the draft, then send a real test email only to your signed-in Sentry
            address. Uses the configured sender with a [TEST] subject. The email binding
            must allow your address. Tests do not reveal shows or change reminders.
          </p>
          <button
            disabled={
              busy || !preview || testStatus === 'sent' || testStatus === 'uncertain'
            }
            onClick={() => void sendTest()}
          >
            {testStarted ? 'Check test attempt' : 'Send test to me'}
          </button>
          {testStarted ? (
            <button
              disabled={busy}
              onClick={() => {
                if (
                  !window.confirm(
                    'Start a new test attempt? Check your inbox first: the previous email may already have arrived.',
                  )
                )
                  return;
                testPayload.current = null;
                setTestStatus(null);
                setTestStarted(false);
                setNotice('');
                setError(null);
              }}
            >
              Start another test
            </button>
          ) : null}
          {preview ? (
            <>
              <h4>Draft preview — not sent</h4>
              <p>Subject: {preview.subject}</p>
              <EmailPreviewFrame html={preview.html} />
              <details>
                <summary>Plain-text fallback</summary>
                <pre>{preview.text}</pre>
              </details>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
