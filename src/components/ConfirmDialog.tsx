"use client";

// Small confirmation modal. We deliberately don't use Base UI's Dialog here —
// its outside-click + focus-trap interactions misfire when the dialog opens as
// a side effect of an input blur (the very flow we use for the reminder/lead
// confirmation). This component is plain-DOM: a controlled <div> overlay,
// Escape to cancel, backdrop click to cancel, buttons to act explicitly. No
// portal, no focus management beyond a basic dialog role.

import { useEffect } from "react";

export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  description,
  cancelLabel = "Cancel",
  confirmLabel,
  destructive = false,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
  description: React.ReactNode;
  cancelLabel?: string;
  confirmLabel: string;
  destructive?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-[1px]"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div className="relative z-10 w-full max-w-sm rounded-xl bg-neutral-900 p-4 text-sm shadow-xl ring-1 ring-white/10">
        <h2 className="text-base font-medium leading-tight text-white">{title}</h2>
        <div className="mt-2 text-sm text-white/70">{description}</div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm text-white/70 hover:bg-white/5"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={
              destructive
                ? "rounded-md bg-red-500/15 px-3 py-1.5 text-sm text-red-200 ring-1 ring-red-500/30 hover:bg-red-500/25"
                : "rounded-md bg-[color:var(--color-brand-600)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[color:var(--color-brand-500)]"
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
