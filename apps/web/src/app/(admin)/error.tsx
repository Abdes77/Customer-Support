"use client";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";

/**
 * What a screen of the admin panel shows when it fails unexpectedly (a page that could not
 * load, or an action that could not reach the server): a plain sentence and a way to try
 * again, never the error's own text, which can hold internals.
 */
export default function AdminError({ reset }: { readonly reset: () => void }) {
  return (
    <div className="max-w-xl space-y-4">
      <Callout tone="danger" title="Something went wrong">
        This screen could not be shown. Try again; if it keeps failing, reload the page or check the
        server log.
      </Callout>
      <Button variant="secondary" onClick={() => reset()}>
        Try again
      </Button>
    </div>
  );
}
