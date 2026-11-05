import { InviteAccept } from "../TokenFlows";

export default async function InvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return <InviteAccept token={token} />;
}
