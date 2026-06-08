"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";

type Mode = "magic" | "password";

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; email: string }
  | { kind: "error"; message: string };

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") ?? "/";
  const [mode, setMode] = useState<Mode>("magic");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function handleMagic(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;

    setStatus({ kind: "sending" });
    const supabase = createClient();
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}`;

    const { error } = await supabase.auth.signInWithOtp({
      email: trimmed,
      options: { emailRedirectTo: redirectTo },
    });

    if (error) {
      setStatus({ kind: "error", message: error.message });
      return;
    }
    setStatus({ kind: "sent", email: trimmed });
  }

  async function handlePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) return;

    setStatus({ kind: "sending" });
    const supabase = createClient();

    const { error } = await supabase.auth.signInWithPassword({
      email: trimmedEmail,
      password,
    });

    if (error) {
      setStatus({ kind: "error", message: error.message });
      return;
    }
    router.push(nextPath);
    router.refresh();
  }

  if (status.kind === "sent") {
    return (
      <div className="space-y-2 rounded-md border border-dashed bg-muted/40 p-4 text-sm">
        <p className="font-medium">Check your inbox.</p>
        <p className="text-muted-foreground">
          We sent a magic link to <span className="font-medium text-foreground">{status.email}</span>.
          Click the link in the email to sign in.
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={mode === "magic" ? handleMagic : handlePassword}
      className="space-y-4"
    >
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={status.kind === "sending"}
        />
      </div>

      {mode === "password" && (
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={status.kind === "sending"}
          />
        </div>
      )}

      {status.kind === "error" && (
        <p className="text-sm text-destructive">{status.message}</p>
      )}

      <Button type="submit" className="w-full" disabled={status.kind === "sending"}>
        {status.kind === "sending"
          ? mode === "magic"
            ? "Sending..."
            : "Signing in..."
          : mode === "magic"
            ? "Send magic link"
            : "Sign in"}
      </Button>

      <div className="text-center text-xs text-muted-foreground">
        {mode === "magic" ? (
          <button
            type="button"
            className="underline hover:text-foreground"
            onClick={() => {
              setStatus({ kind: "idle" });
              setMode("password");
            }}
          >
            Sign in with a password instead
          </button>
        ) : (
          <button
            type="button"
            className="underline hover:text-foreground"
            onClick={() => {
              setStatus({ kind: "idle" });
              setMode("magic");
            }}
          >
            Use a magic link instead
          </button>
        )}
      </div>
    </form>
  );
}
