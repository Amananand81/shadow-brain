import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10" style={{ background: "var(--bg-deep)" }}>
      <SignIn
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        signUpFallbackRedirectUrl="/"
        forceRedirectUrl="/"
      />
    </main>
  );
}
