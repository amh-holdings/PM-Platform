"use client";

import { Button } from "@/components/ui/button";

// Opens the browser print dialog; the user picks "Save as PDF" to get the file
// that is kept behind the owner's submission. Hidden on the printed page.
export function PrintButton() {
  return (
    <Button size="sm" onClick={() => window.print()} className="print:hidden">
      Print / Save as PDF
    </Button>
  );
}
