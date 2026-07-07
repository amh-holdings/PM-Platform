import Link from "next/link";

import { guardCapability } from "@/lib/roles-server";

import { NewChangeOrderForm } from "./new-co-form";

type Params = { id: string };

export default async function NewChangeOrderPage({ params }: { params: Params }) {
  await guardCapability("viewChangeOrders");
  return (
    <div className="space-y-4">
      <div>
        <Link
          href={`/projects/${params.id}/change-orders`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          &larr; Change orders
        </Link>
        <h2 className="mt-1 text-lg font-semibold">New change order</h2>
        <p className="text-xs text-muted-foreground">
          Create the change order header here. Add SOV line items from the
          detail page after saving.
        </p>
      </div>
      <NewChangeOrderForm projectId={params.id} />
    </div>
  );
}
