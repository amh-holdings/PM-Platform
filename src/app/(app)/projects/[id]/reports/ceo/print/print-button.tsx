"use client";

import { Button } from "@/components/ui/button";

// Opens the browser print dialog; "Save as PDF" produces the file that goes to
// the CEO. Hidden on the printed page itself.
export function PrintButton() {
  return (
    <Button size="sm" onClick={() => window.print()} className="print:hidden">
      Print / Save as PDF
    </Button>
  );
}
