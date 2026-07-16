"use client";

import { Button } from "@/components/ui/button";

// Opens the browser print dialog. The user picks "Save as PDF" to archive the
// report. Hidden on the printed page itself via the `print:hidden` utility.
export function PrintButton() {
  return (
    <Button size="sm" onClick={() => window.print()} className="print:hidden">
      Print / Save as PDF
    </Button>
  );
}
