"use client";

import { useState } from "react";

// INSECURE FIXTURE: a server-only secret referenced from a client component (it would be inlined or undefined).
export default function Dashboard() {
  const [plan] = useState("pro");
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  return (
    <main>
      <h1>Dashboard</h1>
      <p>Plan: {plan}</p>
      <button onClick={() => fetch("/api/checkout", { method: "POST", headers: { Authorization: `Bearer ${stripeKey}` } })}>Upgrade</button>
    </main>
  );
}
