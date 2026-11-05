import Link from "next/link";
import { getT } from "@/i18n/server";

export default async function NotFound() {
  const { t } = await getT();
  return (
    <main id="main" className="container" style={{ minHeight: "80dvh", display: "grid", alignContent: "center", gap: "var(--space-5)" }}>
      <p className="eyebrow">404</p>
      <h1 style={{ fontSize: "var(--step-5)", fontWeight: 300 }}>{t("errors.pageNotFound")}</h1>
      <p className="muted">{t("errors.pageNotFoundBody")}</p>
      <div>
        <Link href="/" className="btn btn-primary">
          {t("errors.goHome")}
        </Link>
      </div>
    </main>
  );
}
