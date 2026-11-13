"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";

export const US_TIME_ZONES = [
  ["America/New_York", "Eastern (New York)"],
  ["America/Detroit", "Eastern (Detroit)"],
  ["America/Indiana/Indianapolis", "Eastern (Indianapolis)"],
  ["America/Chicago", "Central (Chicago)"],
  ["America/Denver", "Mountain (Denver)"],
  ["America/Boise", "Mountain (Boise)"],
  ["America/Phoenix", "Arizona (Phoenix, no daylight saving)"],
  ["America/Los_Angeles", "Pacific (Los Angeles)"],
  ["America/Anchorage", "Alaska (Anchorage)"],
  ["Pacific/Honolulu", "Hawaii (Honolulu)"],
  ["America/Puerto_Rico", "Atlantic (Puerto Rico)"],
] as const;

export interface ProfileValues {
  readonly name: string;
  readonly timezone: string;
  readonly websiteUrl: string;
  readonly phone: string;
  readonly email: string;
  readonly addressLine1: string;
  readonly addressLine2: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
}

export interface ProfileFormState {
  readonly error: string | null;
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly values: ProfileValues;
}

/** The business profile form, for creating a business and for editing one. */
export function ProfileForm({
  action,
  initial,
  businessId,
  submitLabel,
}: {
  readonly action: (state: ProfileFormState, form: FormData) => Promise<ProfileFormState>;
  readonly initial: ProfileValues;
  readonly businessId: string | null;
  readonly submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, {
    error: null,
    fieldErrors: {},
    values: initial,
  });
  const v = state.values;
  const err = (name: keyof ProfileValues) => state.fieldErrors[name] ?? null;
  const zones = US_TIME_ZONES.some(([zone]) => zone === v.timezone)
    ? US_TIME_ZONES
    : [[v.timezone, v.timezone] as const, ...US_TIME_ZONES];
  return (
    <form action={formAction} className="space-y-5" noValidate>
      {businessId !== null && <input type="hidden" name="businessId" value={businessId} />}
      {state.error !== null && (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {state.error}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Business name" htmlFor="name" error={err("name")} className="sm:col-span-2">
          <Input
            id="name"
            name="name"
            required
            maxLength={120}
            defaultValue={v.name}
            autoComplete="organization"
            aria-invalid={err("name") !== null || undefined}
          />
        </Field>
        <Field
          label="Website"
          htmlFor="websiteUrl"
          error={err("websiteUrl")}
          help="Used for the website reader and in the bot's answers."
        >
          <Input
            id="websiteUrl"
            name="websiteUrl"
            type="url"
            placeholder="https://www.example.com"
            defaultValue={v.websiteUrl}
            aria-invalid={err("websiteUrl") !== null || undefined}
          />
        </Field>
        <Field
          label="Time zone"
          htmlFor="timezone"
          error={err("timezone")}
          help="Business hours and quiet hours are read in this zone."
        >
          <Select id="timezone" name="timezone" defaultValue={v.timezone}>
            {zones.map(([zone, label]) => (
              <option key={zone} value={zone}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Phone" htmlFor="phone" error={err("phone")}>
          <Input
            id="phone"
            name="phone"
            type="tel"
            defaultValue={v.phone}
            autoComplete="tel"
            aria-invalid={err("phone") !== null || undefined}
          />
        </Field>
        <Field label="Email" htmlFor="email" error={err("email")}>
          <Input
            id="email"
            name="email"
            type="email"
            defaultValue={v.email}
            autoComplete="email"
            aria-invalid={err("email") !== null || undefined}
          />
        </Field>
        <Field
          label="Street address"
          htmlFor="addressLine1"
          error={err("addressLine1")}
          className="sm:col-span-2"
        >
          <Input
            id="addressLine1"
            name="addressLine1"
            defaultValue={v.addressLine1}
            autoComplete="address-line1"
          />
        </Field>
        <Field
          label="Address line 2"
          htmlFor="addressLine2"
          error={err("addressLine2")}
          className="sm:col-span-2"
        >
          <Input
            id="addressLine2"
            name="addressLine2"
            defaultValue={v.addressLine2}
            autoComplete="address-line2"
          />
        </Field>
        <Field label="City" htmlFor="city" error={err("city")}>
          <Input id="city" name="city" defaultValue={v.city} autoComplete="address-level2" />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="State" htmlFor="state" error={err("state")}>
            <Input
              id="state"
              name="state"
              maxLength={2}
              placeholder="TX"
              defaultValue={v.state}
              autoComplete="address-level1"
              aria-invalid={err("state") !== null || undefined}
            />
          </Field>
          <Field label="ZIP code" htmlFor="postalCode" error={err("postalCode")}>
            <Input
              id="postalCode"
              name="postalCode"
              inputMode="numeric"
              maxLength={10}
              defaultValue={v.postalCode}
              autoComplete="postal-code"
              aria-invalid={err("postalCode") !== null || undefined}
            />
          </Field>
        </div>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
