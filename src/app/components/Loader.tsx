import type {ReactNode} from 'react';

/** A rotating reel around a stationary play symbol; decorative, not a control. */
export function Loader() {
  return (
    <div className="reelLoader" aria-hidden="true">
      <span className="reelLoaderRing" />
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M8 5v14l11-7Z" fill="currentColor" />
      </svg>
    </div>
  );
}

export function PageState({
  title,
  detail,
  tone = 'neutral',
  loading = false,
  children,
}: {
  title: string;
  detail: string;
  tone?: 'neutral' | 'error';
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <section
      className={`pageState pageState--${tone}${loading ? ' pageState--loading' : ''}`}
      aria-busy={loading || undefined}
      aria-live="polite"
      role={tone === 'error' ? 'alert' : undefined}
    >
      {loading ? <Loader /> : null}
      <p className="kicker">Sentry Show &amp; Tell</p>
      <h1>{title}</h1>
      <p>{detail}</p>
      {children}
    </section>
  );
}
