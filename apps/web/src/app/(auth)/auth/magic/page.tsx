import { MagicVerify } from "../../TokenFlows";

export default async function MagicPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <MagicVerify token={token} />;
}
