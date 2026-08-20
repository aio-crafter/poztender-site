"use client";

import { useEffect, useRef, useState } from "react";

interface CopyButtonProps {
  value: string;
  label: string;
  /** Announced after a successful copy. */
  doneLabel?: string;
}

/**
 * A plain <button>, so it is reachable and operable from the keyboard without
 * any extra handling. The clipboard API is unavailable over plain HTTP and in
 * older browsers; in that case the button reports the failure instead of
 * pretending to have worked, and the value stays visible on the page for
 * manual selection.
 */
export function CopyButton({ value, label, doneLabel = "Скопировано" }: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setState("done");
    } catch {
      setState("failed");
    }
    timer.current = setTimeout(() => setState("idle"), 2500);
  }

  return (
    <button type="button" className="copy-button" onClick={copy} data-state={state}>
      <span aria-hidden="true">{state === "done" ? "✓" : "⧉"}</span>
      <span>{state === "done" ? doneLabel : state === "failed" ? "Скопируйте вручную" : label}</span>
      {/* Keeps a screen reader informed without moving focus. */}
      <span className="visually-hidden" role="status" aria-live="polite">
        {state === "done" ? doneLabel : state === "failed" ? "Не удалось скопировать" : ""}
      </span>
    </button>
  );
}
