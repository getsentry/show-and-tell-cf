import {useLayoutEffect, useId, useRef} from 'react';
import {createPortal} from 'react-dom';

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel,
  busy = false,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    const trigger = document.activeElement;
    dialog.showModal();
    cancelRef.current?.focus();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({preventScroll: true});
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="confirmDialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      <p id={descriptionId}>{description}</p>
      {error ? (
        <p className="inlineError" role="alert">
          {error}
        </p>
      ) : null}
      <div className="confirmDialogActions">
        <button ref={cancelRef} disabled={busy} onClick={onCancel}>
          {cancelLabel}
        </button>
        <button className="dangerAction" disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
