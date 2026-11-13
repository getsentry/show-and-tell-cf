import {useRef, useState, type DragEvent} from 'react';

import {VIDEO_ACCEPT} from '../video-upload';
import {ArrowIcon} from './ArrowIcon';

const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');

/** Dashed video picker that also accepts a file dropped anywhere on it. */
export function VideoFilePicker({
  id,
  label,
  disabled,
  describedBy,
  onSelect,
}: {
  id: string;
  label: string;
  disabled: boolean;
  describedBy: string;
  onSelect: (file: File | undefined, input: HTMLInputElement) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  // Always claim file drags so a drop never navigates away to the raw video.
  function dragOver(event: DragEvent<HTMLLabelElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
    setDragging(!disabled);
  }

  function dragLeave(event: DragEvent<HTMLLabelElement>) {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setDragging(false);
  }

  function drop(event: DragEvent<HTMLLabelElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    setDragging(false);
    const {files} = event.dataTransfer;
    // An empty drop (e.g. from a source that exposes no files) keeps the current pick.
    if (disabled || !input.current || !files.length) return;
    // Keep the native input showing the dropped file's name.
    if (files instanceof FileList) input.current.files = files;
    onSelect(files[0], input.current);
  }

  return (
    <label
      className={dragging ? 'filePicker filePicker--dragging' : 'filePicker'}
      htmlFor={id}
      onDragEnter={dragOver}
      onDragOver={dragOver}
      onDragLeave={dragLeave}
      onDrop={drop}
    >
      <span className="filePickerIcon">
        <ArrowIcon direction="up" />
      </span>
      {label}
      <input
        ref={input}
        id={id}
        type="file"
        accept={VIDEO_ACCEPT}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) =>
          onSelect(event.currentTarget.files?.[0], event.currentTarget)
        }
      />
    </label>
  );
}
