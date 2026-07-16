// Accessible confirm modal that replaces window.confirm so the dialog matches
// the app's typography, buttons, and focus behavior. Built on the native
// <dialog> element so the browser handles focus trap, ESC-to-close, and
// inert background for us.

import { useEffect, useRef } from "react";

interface ConfirmModalProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Visual emphasis on the confirm button: 'danger' = destructive action. */
  variant?: "danger" | "primary";
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "primary",
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);

  // Drive the native <dialog> imperatively to match the open prop.
  // showModal() handles focus trap, ESC, and inert background automatically.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // Focus Cancel by default: safer than auto-focusing a destructive action.
      requestAnimationFrame(() => cancelBtnRef.current?.focus());
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="confirm-modal"
      aria-labelledby="confirm-modal-title"
      aria-describedby="confirm-modal-body"
      onCancel={(e) => {
        // Native ESC dispatches a "cancel" event before close, so intercept
        // so the parent state stays in sync.
        e.preventDefault();
        onCancel();
      }}
      onClick={(e) => {
        // Clicks on the dialog backdrop (the dialog element itself, not
        // its content) come through with target === dialog. Treat as cancel.
        if (e.target === dialogRef.current) onCancel();
      }}
    >
      <div className="confirm-modal-inner">
        <h2 id="confirm-modal-title" className="confirm-modal-title">{title}</h2>
        <p id="confirm-modal-body" className="confirm-modal-body">{body}</p>
        <div className="confirm-modal-actions">
          <button
            ref={cancelBtnRef}
            type="button"
            className="btn btn-neutral"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${variant === "danger" ? "btn-danger" : "btn-brand"}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
