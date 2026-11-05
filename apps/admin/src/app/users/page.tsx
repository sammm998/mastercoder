import type { Metadata } from "next";
import { UsersView } from "@/components/views/UsersView";
import { S } from "@/lib/strings";

export const metadata: Metadata = { title: S.nav.users };

export default function Page() {
  return <UsersView />;
}
