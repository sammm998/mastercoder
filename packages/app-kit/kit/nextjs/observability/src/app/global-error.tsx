"use client";

import { useEffect } from "react";
import { sendClientError } from "@/kit/client-error-listener";

/** Last-resort error page (replaces the root layout). The error is reported to Forge. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    sendClientError(error);
  }, [error]);
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "4rem 1.5rem", maxWidth: "40rem", margin: "0 auto" }}>
        <main>
          <h1>Something went wrong</h1>
          <p>The error has been reported. You can try again.</p>
          {error.digest && <p style={{ color: "#555" }}>Reference: {error.digest}</p>}
          <button type="button" onClick={() => reset()} style={{ padding: "0.75rem 1.5rem", font: "inherit" }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
