import { ENV_GROUPS, ENV_NAMES, ENV_SPEC, type EnvVarSpec } from "./spec";

const HEADER = `# Environment variables for the home-services reply bot.
#
# GENERATED from packages/core/src/env/spec.ts by "pnpm env:example". Do not edit by hand.
# Copy to .env.local for local development. Never commit real values.
# docs/HUMAN_TODO.md says where to get each value.
#
# [production] the product cannot run without it
# [feature]    needed only for that channel or integration
# [optional]   has a default or is a convenience
`;

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** Renders the contents of `.env.example` from the spec. */
export function renderEnvExample(): string {
  const sections = ENV_GROUPS.map((group) => {
    const names = ENV_NAMES.filter((name) => ENV_SPEC[name].group === group.id);
    const entries = names.map((name) => {
      const spec: EnvVarSpec = ENV_SPEC[name];
      const tag = `[${spec.required}]${spec.secret ? " [secret]" : ""}`;
      const comment = wrap(`${tag} ${spec.description}`, 90).map((line) => `# ${line}`);
      return [...comment, `${name}=${spec.example}`].join("\n");
    });
    const rule = "#".repeat(92);
    return [rule, `# ${group.title}`, rule, "", entries.join("\n\n")].join("\n");
  });
  return `${HEADER}\n${sections.join("\n\n")}\n`;
}
