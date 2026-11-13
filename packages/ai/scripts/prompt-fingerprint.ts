/**
 * Prints the hashes that `src/prompt/prompt-versions.test.ts` and `src/prompt/render.test.ts`
 * pin, and with `--print` the whole sample request, to read the prompt as the model gets it.
 *
 *   pnpm --filter @repo/ai prompt:fingerprint            # the two hashes
 *   pnpm --filter @repo/ai prompt:fingerprint --print    # plus the rendered request
 */
import { PHOTO_PROMPT_V1, PHOTO_PROMPT_VERSION } from "../src/photos/analyze";
import { CURRENT_REPLY_PROMPT, PROMPT_VERSION } from "../src/prompt/core";
import { corePromptHash, renderFingerprint, sampleRequest } from "../src/prompt/fingerprint";

console.log(`prompt version:      ${PROMPT_VERSION}`);
console.log(`core prompt (${CURRENT_REPLY_PROMPT.version}): ${corePromptHash()}`);
console.log(`photo prompt (${PHOTO_PROMPT_VERSION}): ${corePromptHash(PHOTO_PROMPT_V1)}`);
console.log(`render fingerprint:  ${renderFingerprint()}`);

if (process.argv.includes("--print")) {
  const request = sampleRequest();
  console.log("\n=== tools ===");
  for (const tool of request.tools) console.log(`- ${tool.name}: ${tool.description ?? ""}`);
  request.system.forEach((block, index) => {
    console.log(`\n=== system[${index}] (${block.text.length} characters) ===\n${block.text}`);
  });
  console.log("\n=== messages ===");
  for (const message of request.messages) {
    const text =
      typeof message.content === "string"
        ? message.content
        : (message.content ?? [])
            .map((block) => ("text" in block ? block.text : `[${block.type}]`))
            .join("\n");
    console.log(`\n--- ${message.role} ---\n${text}`);
  }
}
