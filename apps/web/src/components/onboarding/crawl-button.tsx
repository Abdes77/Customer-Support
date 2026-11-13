"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { crawlWebsiteAction } from "@/app/(admin)/_actions/knowledge";
import { Button } from "@/components/ui/button";

/** Asks for the business's website to be read for facts (when the setting allows it). */
export function CrawlButton({ businessId }: { readonly businessId: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="space-y-2">
      <Button
        variant="secondary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await crawlWebsiteAction({ businessId });
            setMessage(
              result.ok
                ? result.value.started
                  ? "Reading the website. New facts appear in the knowledge editor when it is done."
                  : "The website is already being read."
                : result.error,
            );
            router.refresh();
          })
        }
      >
        Read the website
      </Button>
      {message !== null && (
        <p role="status" className="text-sm text-slate-700">
          {message}
        </p>
      )}
    </div>
  );
}
