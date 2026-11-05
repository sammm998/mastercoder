import type { Metadata } from "next";
import { getT } from "@/i18n/server";
import { LoginForm } from "../AuthForms";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t("auth.login") };
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const sp = await searchParams;
  return <LoginForm next={sp.next} oauthError={sp.error?.slice(0, 200)} />;
}
