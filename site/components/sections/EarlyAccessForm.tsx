"use client";

import { type FormEvent, useState } from "react";

type State = "idle" | "sending" | "done" | "failed";

export default function EarlyAccessForm() {
  const [state, setState] = useState<State>("idle");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = new FormData(event.currentTarget).get("email");
    setState("sending");
    try {
      const response = await fetch("/api/early-access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setState(response.ok ? "done" : "failed");
    } catch {
      setState("failed");
    }
  }

  if (state === "done") {
    return (
      <p className="cta__done" role="status">
        You&apos;re on the list. Chip has stashed your email somewhere safe.
      </p>
    );
  }

  return (
    <form className="cta__form" onSubmit={submit}>
      <label className="sr-only" htmlFor="early-email">
        Email
      </label>
      <input id="early-email" name="email" type="email" required autoComplete="email" placeholder="Enter your email" />
      <button type="submit" className="btn btn--munk" disabled={state === "sending"}>
        {state === "sending" ? "Stashing…" : "Get early access"}
      </button>
      {state === "failed" && (
        <p className="cta__error" role="alert">
          That did not go through. Try again in a moment.
        </p>
      )}
    </form>
  );
}
