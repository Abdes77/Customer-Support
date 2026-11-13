import { z } from "zod";

import { ExternalServiceError } from "@repo/core";
import type { FetchLike } from "@repo/channel-meta";
import type { AppResolvedSettings } from "@repo/settings";

/*
 * Voice messages (`channels.whatsapp.voice_messages`). The engine reads an attachment's
 * stored text in place of the file, so a voice message becomes either its transcript or a
 * note that tells the bot to ask the customer to type. Claude does not take audio, so the
 * transcript comes from a speech-to-text service: Deepgram (DECISIONS), behind the small
 * `Transcriber` port so another provider can replace it.
 */

export interface Transcriber {
  readonly name: string;
  transcribe(audio: { readonly bytes: Uint8Array; readonly mimeType: string }): Promise<string>;
}

/** Shown to the bot when the business does not transcribe, or transcription failed. */
export const ASK_TO_TYPE_NOTE =
  "Voice message (not transcribed: the business does not listen to voice messages). Ask the customer to type their message instead.";

export function transcriptNote(transcript: string): string {
  return `Voice message, transcribed: ${transcript.replace(/\s+/g, " ").trim()}`;
}

const DeepgramResponse = z.object({
  results: z.object({
    channels: z
      .array(
        z.object({
          alternatives: z.array(z.object({ transcript: z.string() }).passthrough()).min(1),
        }),
      )
      .min(1),
  }),
});

/**
 * Deepgram's pre-recorded transcription (`POST https://api.deepgram.com/v1/listen`, the
 * audio as the body, `Authorization: Token <key>`), model `nova-3`, US English, with
 * punctuation. Written from Deepgram's documented API and tested against recorded
 * responses; unverified live (HUMAN_TODO).
 */
export function createDeepgramTranscriber(options: {
  readonly apiKey: string;
  readonly fetch?: FetchLike;
  readonly model?: string;
  readonly timeoutMs?: number;
}): Transcriber {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    name: "deepgram",
    async transcribe(audio) {
      const url = new URL("https://api.deepgram.com/v1/listen");
      url.searchParams.set("model", options.model ?? "nova-3");
      url.searchParams.set("language", "en-US");
      url.searchParams.set("smart_format", "true");
      const copy = new Uint8Array(audio.bytes.byteLength);
      copy.set(audio.bytes);
      let response: Response;
      try {
        response = await doFetch(url.toString(), {
          method: "POST",
          headers: {
            authorization: `Token ${options.apiKey}`,
            "content-type": audio.mimeType.split(";")[0]?.trim() ?? "audio/ogg",
          },
          body: copy,
          signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
        });
      } catch (error) {
        throw new ExternalServiceError("The transcription service could not be reached.", {
          provider: "deepgram",
          cause: error instanceof Error ? error.name : "unknown",
        });
      }
      if (!response.ok) {
        throw new ExternalServiceError(`Transcription failed with HTTP ${response.status}.`, {
          provider: "deepgram",
          status: response.status,
        });
      }
      const parsed = DeepgramResponse.safeParse(await response.json());
      if (!parsed.success) {
        throw new ExternalServiceError("The transcription service answered unexpectedly.", {
          provider: "deepgram",
          retryable: false,
        });
      }
      return parsed.data.results.channels[0]!.alternatives[0]!.transcript.trim();
    },
  };
}

/** Longest voice message sent for transcription (about 15 minutes of WhatsApp audio). */
const MAX_TRANSCRIBE_BYTES = 16 * 1024 * 1024;

/**
 * The attachment enricher for WhatsApp audio (the pipeline's `AttachmentEnricher`). Without
 * a transcriber, or with the setting on "ask to type", the bot gets the note. A failed
 * transcription also falls back to the note (and is logged): retrying would hold up the
 * reply, and failing would leave the customer without one.
 */
export function createVoiceMessageEnricher(options: { readonly transcriber: Transcriber | null }) {
  return {
    name: "whatsapp-voice",
    channel: "whatsapp" as const,
    kinds: ["audio"] as const,
    async enrich(input: {
      readonly mimeType: string | null;
      readonly bytes: Uint8Array | null;
      readonly settings: AppResolvedSettings;
      readonly logger: { warn(event: string, fields?: Record<string, unknown>): void };
    }): Promise<string | null> {
      const mode = input.settings.values["channels.whatsapp.voice_messages"];
      if (
        mode !== "transcribe" ||
        options.transcriber === null ||
        input.bytes === null ||
        input.bytes.byteLength > MAX_TRANSCRIBE_BYTES
      ) {
        return ASK_TO_TYPE_NOTE;
      }
      try {
        const transcript = await options.transcriber.transcribe({
          bytes: input.bytes,
          mimeType: input.mimeType ?? "audio/ogg",
        });
        return transcript.length > 0 ? transcriptNote(transcript) : ASK_TO_TYPE_NOTE;
      } catch (error) {
        input.logger.warn("whatsapp.transcription_failed", {
          provider: options.transcriber.name,
          error,
        });
        return ASK_TO_TYPE_NOTE;
      }
    },
  };
}
