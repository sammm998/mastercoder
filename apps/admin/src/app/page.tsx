import type { Metadata } from "next";
import { OverviewView } from "@/components/views/OverviewView";
import { S } from "@/lib/strings";

export const metadata: Metadata = { title: S.nav.overview };

export default function Page() {
  return <OverviewView />;
}
