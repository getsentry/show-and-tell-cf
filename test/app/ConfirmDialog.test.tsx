import '@testing-library/jest-dom/vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {StrictMode, useState} from 'react';
import {afterEach, expect, it, vi} from 'vitest';
import {ConfirmDialog} from '../../src/app/components/ConfirmDialog';

afterEach(cleanup);

it('uses a modal outside the card, labels its consequences, and focuses cancel', () => {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  const {container, unmount} = render(
    <ConfirmDialog
      title="Remove this video?"
      description="The submission stays saved."
      confirmLabel="Confirm remove video"
      cancelLabel="Keep video"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  const dialog = screen.getByRole('dialog', {name: 'Remove this video?'});
  expect(dialog).toHaveAttribute('open');
  expect(dialog).toHaveAccessibleDescription('The submission stays saved.');
  expect(container).not.toContainElement(dialog);
  expect(screen.getByRole('button', {name: 'Keep video'})).toHaveFocus();
  fireEvent(dialog, new Event('cancel', {cancelable: true}));
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', {name: 'Confirm remove video'}));
  expect(onConfirm).toHaveBeenCalledOnce();
  unmount();
  expect(dialog).not.toHaveAttribute('open');
});

function DialogFlow() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Remove video</button>
      {open ? (
        <ConfirmDialog
          title="Remove this video?"
          description="The submission stays saved."
          confirmLabel="Confirm remove video"
          cancelLabel="Keep video"
          onConfirm={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

it('restores trigger focus on cancel, including strict-mode effect replay', () => {
  render(
    <StrictMode>
      <DialogFlow />
    </StrictMode>,
  );
  const trigger = screen.getByRole('button', {name: 'Remove video'});
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByRole('button', {name: 'Keep video'})).toHaveFocus();
  fireEvent.click(screen.getByRole('button', {name: 'Keep video'}));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it('locks confirmation and cancellation while pending and shows errors in the dialog', () => {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(
    <ConfirmDialog
      title="Delete submission?"
      description="This cannot be undone."
      confirmLabel="Confirm delete"
      cancelLabel="Keep submission"
      busy
      error="Request failed"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveAttribute('aria-busy', 'true');
  fireEvent(dialog, new Event('cancel', {cancelable: true}));
  fireEvent.click(screen.getByRole('button', {name: 'Confirm delete'}));
  fireEvent.click(screen.getByRole('button', {name: 'Keep submission'}));
  expect(onConfirm).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
  expect(dialog).toContainElement(screen.getByRole('alert'));
});
