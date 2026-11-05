import type { Metadata } from "next";
import { getT } from "@/i18n/server";
import { SignupForm } from "../AuthForms";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t("auth.signup") };
}

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const sp = await searchParams;
  return <SignupForm next={sp.next} />;
}
