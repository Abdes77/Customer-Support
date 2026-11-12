/**
 * @repo/ai/testing
 *
 * The mock model for tests in any package: a scripted client that plays back responses in
 * the Claude API's response format and keeps the requests it was given.
 *
 *   import { createScriptedModelClient, scriptedResponse, text, toolUse } from "@repo/ai/testing";
 */
export {
  createScriptedModelClient,
  fallbackBlock,
  type ScriptedModelClient,
  scriptedRefusal,
  scriptedResponse,
  type ScriptedResponseOptions,
  type ScriptedStep,
  text,
  thinking,
  toolUse,
} from "../model/scripted";
export {
  type TestBusiness,
  testBusiness,
  testInput,
  type TestInputOptions,
  type TestSegment,
  testTurn,
} from "./fixtures";
