"use client";

import { useState } from "react";
import { renameNote } from "../actions";

export default function Dashboard() {
  const [plan] = useState("pro");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  return (
    <main>
      <h1>Dashboard</h1>
      <p>
        Plan: {plan} — <a href={`${appUrl}/billing`}>Manage billing</a>
      </p>
      <form action={renameNote}>
        <input name="id" type="hidden" />
        <label>
          Title <input name="title" />
        </label>
        <button type="submit">Rename</button>
      </form>
    </main>
  );
}
