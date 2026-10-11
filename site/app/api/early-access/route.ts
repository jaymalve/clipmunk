const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Forwards an early-access sign-up to the webhook in EARLY_ACCESS_WEBHOOK.
 * Without that variable the sign-up cannot be kept, so the request fails instead of pretending.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (!EMAIL.test(email) || email.length > 254) {
    return Response.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const webhook = process.env.EARLY_ACCESS_WEBHOOK;
  if (!webhook) {
    return Response.json({ error: "Sign-ups are not connected yet." }, { status: 503 });
  }

  const forwarded = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, source: "clipmunk-landing", at: new Date().toISOString() }),
  }).catch(() => null);

  if (!forwarded?.ok) {
    return Response.json({ error: "The sign-up could not be saved." }, { status: 502 });
  }
  return Response.json({ ok: true });
}
