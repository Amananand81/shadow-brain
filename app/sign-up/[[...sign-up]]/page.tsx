import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10" style={{ background: "var(--bg-deep)" }}>
      <SignUp
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        signInFallbackRedirectUrl="/"
        forceRedirectUrl="/"
      />
    </main>
  );
}
