"use client";

// Small "copy to clipboard" button with brief confirmation feedback.

import { useState } from "react";

export function CopyButton({
  text,
  label = "Copy",
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — no-op
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={
        className ??
        "rounded-md bg-white/5 px-2.5 py-1 text-xs text-white/70 ring-1 ring-white/10 hover:bg-white/10"
      }
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}
