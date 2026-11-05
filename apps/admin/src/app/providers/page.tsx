import type { Metadata } from "next";
import { ProvidersView } from "@/components/views/ProvidersView";
import { S } from "@/lib/strings";

export const metadata: Metadata = { title: S.nav.providers };

export default function Page() {
  return <ProvidersView />;
}
