import type { Metadata } from "next";
import { AbuseView } from "@/components/views/AbuseView";
import { S } from "@/lib/strings";

export const metadata: Metadata = { title: S.nav.abuse };

export default function Page() {
  return <AbuseView />;
}
