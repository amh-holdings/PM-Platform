"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

/** Copies the review, worded as the email to the sub, to the clipboard. */
export function CopyLetterButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2500);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "Copied - paste into your email" : "Copy email to sub"}
    </Button>
  );
}
