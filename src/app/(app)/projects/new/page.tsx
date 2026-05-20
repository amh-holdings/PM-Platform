import Link from "next/link";

import { Button } from "@/components/ui/button";
import { ProjectForm } from "./project-form";

export const metadata = {
  title: "New project - AHC PM Platform",
};

export default function NewProjectPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">New project</h1>
          <p className="text-sm text-muted-foreground">
            Only the project name is required - everything else can be filled in later.
          </p>
        </div>
        <Button variant="ghost" asChild>
          <Link href="/projects">Cancel</Link>
        </Button>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <ProjectForm />
      </div>
    </div>
  );
}
