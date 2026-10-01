import { AuthActionScreen } from "@/app/components/AuthActionScreen";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const params = await searchParams;
  const token = Array.isArray(params.token) ? params.token[0] || "" : params.token || "";
  return <AuthActionScreen mode="reset" token={token} />;
}
