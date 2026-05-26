"use client";

import { useFormState, useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { updateProject, type CreateProjectState } from "../../actions";
import { PROJECT_STATUS_OPTIONS } from "../../constants";

const initialState: CreateProjectState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Saving..." : "Save changes"}
    </Button>
  );
}

export type ProjectEditValues = {
  id: string;
  name: string;
  client: string | null;
  status: string | null;
  contract_value: number | null;
  ntp_date: string | null;
  cod_date: string | null;
  zip_code: string | null;
};

export function ProjectEditForm({ project }: { project: ProjectEditValues }) {
  const action = updateProject.bind(null, project.id);
  const [state, formAction] = useFormState(action, initialState);

  return (
    <form action={formAction} className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="name">
            Name <span className="text-destructive">*</span>
          </Label>
          <Input
            id="name"
            name="name"
            required
            defaultValue={project.name}
            placeholder="Sweet Springs Solar"
            aria-invalid={Boolean(state.fieldErrors?.name)}
          />
          {state.fieldErrors?.name && (
            <p className="text-xs text-destructive">{state.fieldErrors.name}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="client">Client / Developer</Label>
          <Input
            id="client"
            name="client"
            defaultValue={project.client ?? ""}
            placeholder="Dimension Energy"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="status">Status</Label>
          <select
            id="status"
            name="status"
            defaultValue={project.status ?? "Planning"}
            className={cn(
              "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
              "ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            )}
          >
            {PROJECT_STATUS_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="contract_value">Contract value (USD)</Label>
          <Input
            id="contract_value"
            name="contract_value"
            type="text"
            inputMode="decimal"
            defaultValue={project.contract_value ?? ""}
            placeholder="2500000"
            aria-invalid={Boolean(state.fieldErrors?.contract_value)}
          />
          {state.fieldErrors?.contract_value && (
            <p className="text-xs text-destructive">{state.fieldErrors.contract_value}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="zip_code">Zip code</Label>
          <Input
            id="zip_code"
            name="zip_code"
            defaultValue={project.zip_code ?? ""}
            placeholder="65351"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="ntp_date">NTP date</Label>
          <Input
            id="ntp_date"
            name="ntp_date"
            type="date"
            defaultValue={project.ntp_date ?? ""}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="cod_date">COD date</Label>
          <Input
            id="cod_date"
            name="cod_date"
            type="date"
            defaultValue={project.cod_date ?? ""}
          />
        </div>
      </div>

      {state.error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {state.error}
        </div>
      )}

      <div className="flex justify-end">
        <SubmitButton />
      </div>
    </form>
  );
}
