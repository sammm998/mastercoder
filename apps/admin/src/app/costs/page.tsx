import type { Metadata } from "next";
import { CostsView } from "@/components/views/CostsView";
import { S } from "@/lib/strings";

export const metadata: Metadata = { title: S.nav.costs };

export default function Page() {
  return <CostsView />;
}
